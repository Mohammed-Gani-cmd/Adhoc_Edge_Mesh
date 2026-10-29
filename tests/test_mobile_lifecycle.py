"""Mobile HTTP contract, withdrawal, retry, and ZIP aggregation regressions."""
import io
import json
import threading
import time
import zipfile
from concurrent.futures import Future

import pytest
from PIL import Image

from edge_mesh.app import create_app
from edge_mesh.config import Config
from edge_mesh.mobile_workers import MobileWorkers


def image_bytes(width=120, height=80):
    output = io.BytesIO()
    Image.new('RGB', (width, height), 'white').save(output, format='PNG')
    return output.getvalue()


def until(predicate):
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(0.01)
    pytest.fail('Timed out waiting for mobile task/job')


@pytest.fixture
def coordinator(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    app, _ = create_app(Config(name='Coordinator', token='shared', port=5100))
    app.testing = True
    client = app.test_client()
    auth = {'X-Edge-Token': 'shared'}
    registered = client.post('/api/v1/mobile/workers/register', json={
        'name': 'Test phone', 'platform': 'ios', 'client_id': 'a' * 32,
        'free_memory_mb': 2048, 'total_memory_mb': 4096,
    }, headers=auth)
    worker_id = registered.get_json()['worker_id']
    peers = app.config['EDGE_PEERS']
    # Force a phone assignment; allow local retry only after the phone withdraws.
    def snapshot():
        phones = peers.mobile_workers.snapshot()
        if phones:
            return phones
        return [{'node_id': 'local', 'name': 'Coordinator', 'online': True,
                 'source': 'local', 'capacity': 1, 'cpu_percent': 0}]
    monkeypatch.setattr(peers, 'snapshot', snapshot)
    return client, auth, worker_id, peers.mobile_workers


def submit_and_poll(coordinator):
    client, auth, worker_id, _ = coordinator
    submitted = client.post('/api/v1/jobs', data={
        'images': (io.BytesIO(image_bytes()), 'sample.png'),
        'max_width': '60', 'max_height': '60',
    }, content_type='multipart/form-data')
    assert submitted.status_code == 202
    job_id = submitted.get_json()['job_id']
    def poll():
        result = client.get(f'/api/v1/mobile/workers/{worker_id}/tasks/next', headers=auth)
        assert result.status_code in {200, 204}
        return result.get_json() if result.status_code == 200 else None
    return job_id, until(poll)


def finished_job(client, job_id):
    def poll():
        job = client.get(f'/api/v1/jobs/{job_id}').get_json()
        return job if job['status'] in {'completed', 'failed'} else None
    return until(poll)


def check_zip(client, job_id, location):
    response = client.get(f'/api/v1/jobs/{job_id}/download')
    assert response.status_code == 200
    with zipfile.ZipFile(io.BytesIO(response.data)) as archive:
        manifest = json.loads(archive.read('manifest.json'))
        item = manifest['items'][0]
        assert item['execution_location'] == location
        assert item['output_size'] == [60, 40]
        image_name = next(name for name in archive.namelist() if name != 'manifest.json')
        with Image.open(io.BytesIO(archive.read(image_name))) as image:
            assert image.size == (60, 40)
            image.verify()
    return item


def test_mobile_http_roundtrip_and_download_manifest(coordinator):
    client, auth, worker_id, _ = coordinator
    job_id, task = submit_and_poll(coordinator)
    assert task['job_id'] == job_id
    assert task['item_id'] == '0'
    path = f'/api/v1/mobile/workers/{worker_id}/tasks/{task["task_id"]}'
    assert client.get(path + '/input').status_code == 401
    source = client.get(path + '/input', headers=auth)
    assert source.status_code == 200
    with Image.open(io.BytesIO(source.data)) as image:
        assert image.size == (120, 80)
    uploaded = client.post(path + '/result', data={
        'image': (io.BytesIO(image_bytes(60, 40)), 'output.png'), 'processing_ms': '12',
    }, headers=auth, content_type='multipart/form-data')
    assert uploaded.status_code == 200
    assert finished_job(client, job_id)['status'] == 'completed'
    item = check_zip(client, job_id, 'mobile')
    assert item['assigned_node'] == 'Test phone'
    assert item['attempts'] == 1
    assert client.post(path + '/result', data={
        'image': (io.BytesIO(image_bytes(60, 40)), 'duplicate.png'),
    }, headers=auth).status_code == 409
    assert client.post(path + '/fail', json={'error': 'late error'}, headers=auth).status_code == 404


def test_withdrawal_requires_auth_and_is_idempotent(coordinator):
    client, auth, worker_id, workers = coordinator
    path = f'/api/v1/mobile/workers/{worker_id}'
    assert client.delete(path).status_code == 401
    assert len(workers.snapshot()) == 1
    assert client.delete(path, headers=auth).status_code == 204
    assert client.delete(path, headers=auth).status_code == 204
    assert workers.snapshot() == []
    assert client.get(path + '/tasks/next', headers=auth).status_code == 404
    assert client.post(path + '/heartbeat', json={}, headers=auth).status_code == 404


def test_withdrawing_assigned_phone_retries_locally_and_rejects_late_output(coordinator):
    client, auth, worker_id, _ = coordinator
    job_id, task = submit_and_poll(coordinator)
    path = f'/api/v1/mobile/workers/{worker_id}'
    assert client.delete(path, headers=auth).status_code == 204
    job = finished_job(client, job_id)
    assert job['status'] == 'completed'
    assert [attempt['status'] for attempt in job['items'][0]['attempts']] == ['failed', 'completed']
    item = check_zip(client, job_id, 'local')
    assert item['attempts'] == 2
    task_path = path + f'/tasks/{task["task_id"]}'
    assert client.get(task_path + '/input', headers=auth).status_code == 404
    assert client.post(task_path + '/result', data={
        'image': (io.BytesIO(image_bytes(60, 40)), 'late.png'),
    }, headers=auth).status_code == 409


def test_duplicate_future_completion_is_rejected_before_executor_cleanup():
    workers = MobileWorkers()
    worker_id = workers.register('Phone')
    future = Future()
    workers.tasks['task'] = {
        'worker_id': worker_id, 'future': future, 'data': b'image', 'max_width': 60, 'max_height': 60,
    }
    result = {'format': 'JPEG', 'size': [60, 40], 'data': b'result'}
    assert workers.complete(worker_id, 'task', result)
    assert not workers.complete(worker_id, 'task', result)
    assert not workers.fail(worker_id, 'task', 'late failure')
    assert workers.task_input(worker_id, 'task') is None
    workers.withdraw(worker_id)
    assert future.result() == result


def test_reregistering_phone_releases_old_tasks_without_damaging_new_session():
    workers = MobileWorkers()
    worker_id = workers.register('Phone', client_id='b' * 32)
    outcome = []
    def execute():
        try:
            workers.execute(worker_id, {'filename': 'input.png', 'data': b'image', 'max_width': 60, 'max_height': 60})
        except RuntimeError as error:
            outcome.append(str(error))
    thread = threading.Thread(target=execute)
    thread.start()
    until(lambda: workers.next_task(worker_id))
    assert workers.register('Phone', client_id='b' * 32) == worker_id
    thread.join(timeout=2)
    assert not thread.is_alive()
    assert outcome == ['Phone worker left the mesh']
    assert workers.snapshot()[0]['in_flight'] == 0
    assert workers.snapshot()[0]['online']
    workers.withdraw(worker_id)


def test_mdns_callback_accepts_zeroconf_keyword_arguments():
    import socket
    from types import SimpleNamespace
    from edge_mesh.discovery import Discovery, ServiceStateChange

    discovery = Discovery('Coordinator', 5000, '1.1')
    info = SimpleNamespace(addresses=[socket.inet_aton('192.168.1.20')], port=5001,
                           properties={b'node_id': b'other-node', b'display_name': b'Other laptop'})
    provider = SimpleNamespace(get_service_info=lambda *args, **kwargs: info)
    discovery._on_change(zeroconf=provider, service_type=discovery.service_type,
                         name='test-service', state_change=ServiceStateChange.Added)
    assert discovery.list_peers()[0]['host'] == '192.168.1.20'
    discovery._on_change(zeroconf=provider, service_type=discovery.service_type,
                         name='test-service', state_change=ServiceStateChange.Removed)
    assert discovery.list_peers() == []
