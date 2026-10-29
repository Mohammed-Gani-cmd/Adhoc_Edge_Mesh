"""Coordinator mode selection and per-job routing without AWS calls."""
import io
import threading
import time
from types import SimpleNamespace

from PIL import Image

from edge_mesh.app import create_app
from edge_mesh.config import Config
from edge_mesh.jobs import JobManager


def png():
    output = io.BytesIO()
    Image.new('RGB', (16, 8), 'white').save(output, 'PNG')
    return output.getvalue()


def upload(client, source):
    response = client.post('/api/v1/jobs', data={
        'images': (io.BytesIO(png()), 'test.png'), 'submitted_from': source,
        'max_width': '8', 'max_height': '8',
    })
    assert response.status_code == 202
    return response.json


def test_mode_endpoint_requires_local_browser_and_valid_mode(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    app, _ = create_app(Config())
    client = app.test_client()
    url = '/api/v1/execution-mode'
    local = {'base_url': 'http://127.0.0.1:5000', 'headers': {'Origin': 'http://127.0.0.1:5000'}}
    assert client.post(url, json={'execution_mode': 'cloud'}, **local).status_code == 409
    assert client.post(url, json={'execution_mode': 'invalid'}, **local).status_code == 400
    assert client.post(url, json={'execution_mode': 'mesh'}, base_url='http://192.0.2.1:5000', headers={'Origin': 'http://127.0.0.1:5000'}).status_code == 403
    assert client.post(url, json={'execution_mode': 'mesh'}, base_url='http://127.0.0.1:5000', headers={'Origin': 'http://evil.example'}).status_code == 403
    assert client.post(url, json={'execution_mode': 'mesh'}, environ_base={'REMOTE_ADDR': '192.0.2.8'}, **local).status_code == 403
    assert client.post(url, json={'execution_mode': 'mesh'}, base_url='http://127.0.0.1:5000').status_code == 403
    assert client.post(url, json={'execution_mode': 'mesh'}, base_url='http://localhost:5000', headers={'Origin': 'http://localhost:5000'}).status_code == 200
    assert client.post(url, json={'execution_mode': 'mesh'}, base_url='http://127.0.0.1:5000', headers={'Origin': 'http://127.0.0.1:5173'}).status_code == 200
    assert client.get('/api/v1/status').json['execution_mode'] == 'mesh'


def test_web_phone_and_switch_during_active_job(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    app, _ = create_app(Config())
    manager = app.config['EDGE_JOBS']
    client = app.test_client()
    manager.cloud_fallback = SimpleNamespace(execute=lambda *args: (_ for _ in ()).throw(RuntimeError('AWS denied')))
    started = threading.Event()
    release = threading.Event()
    original = manager._execute

    def slow_mesh(job, item, node):
        started.set()
        assert release.wait(5)
        return original(job, item, node)

    monkeypatch.setattr(manager, '_execute', slow_mesh)
    mesh = upload(client, 'web')
    assert started.wait(5)
    response = client.post('/api/v1/execution-mode', json={'execution_mode': 'cloud'}, base_url='http://127.0.0.1:5000', headers={'Origin': 'http://127.0.0.1:5000'})
    assert response.json['execution_mode'] == 'cloud'
    cloud = upload(client, 'mobile')
    release.set()
    response = client.post('/api/v1/execution-mode', json={'execution_mode': 'mesh'}, base_url='http://127.0.0.1:5000', headers={'Origin': 'http://127.0.0.1:5000'})
    assert response.json['execution_mode'] == 'mesh'
    assert client.get('/api/v1/status').json['execution_mode'] == 'mesh'
    mesh_again = upload(client, 'web')
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if all(manager.get(job['job_id'])['status'] in {'completed', 'failed'} for job in (mesh, cloud, mesh_again)):
            break
        time.sleep(0.01)
    mesh_result = manager.get(mesh['job_id'])
    cloud_result = manager.get(cloud['job_id'])
    assert mesh_result['execution_mode'] == 'mesh'
    assert mesh_result['items'][0]['execution_location'] == 'local'
    assert cloud_result['execution_mode'] == 'cloud'
    assert cloud_result['items'][0]['state'] == 'failed'
    assert [a['node_id'] for a in cloud_result['items'][0]['attempts']] == ['cloud']
    assert manager.get(mesh_again['job_id'])['execution_mode'] == 'mesh'
    assert manager.get(mesh_again['job_id'])['items'][0]['execution_location'] == 'local'
    assert client.get('/api/v1/jobs').json['jobs'][0]['execution_mode'] == 'mesh'
    restarted, _ = create_app(Config())
    assert restarted.test_client().get('/api/v1/status').json['execution_mode'] == 'mesh'
