"""Jobs submitted by any client must be discoverable on the coordinator."""
import io
import threading

import pytest
from PIL import Image

from edge_mesh.app import create_app
from edge_mesh.config import Config


@pytest.fixture
def coordinator(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    app, _ = create_app(Config())
    app.testing = True
    manager = app.config['EDGE_JOBS']
    monkeypatch.setattr(manager, '_run', lambda job_id: None)
    return app.test_client(), manager


def submit(client, source=None):
    raw = io.BytesIO()
    Image.new('RGB', (4, 3), 'white').save(raw, format='PNG')
    raw.seek(0)
    form = {'images': (raw, 'test.png')}
    if source is not None:
        form['submitted_from'] = source
    response = client.post('/api/v1/jobs', data=form)
    assert response.status_code == 202
    return response.get_json()


def test_phone_browser_and_legacy_jobs_are_discovered_together(coordinator):
    client, manager = coordinator
    assert client.get('/api/v1/jobs').get_json() == {'jobs': []}
    phone = submit(client, 'mobile')
    browser = submit(client, 'web')
    legacy = submit(client)
    unknown = submit(client, 'untrusted-label')
    assert phone['submitted_from'] == 'mobile'
    assert browser['submitted_from'] == 'web'
    assert legacy['submitted_from'] == unknown['submitted_from'] == 'unknown'
    jobs = client.get('/api/v1/jobs').get_json()['jobs']
    assert {row['job_id'] for row in jobs} == {phone['job_id'], browser['job_id'], legacy['job_id'], unknown['job_id']}
    assert [row['created_at'] for row in jobs] == sorted([row['created_at'] for row in jobs], reverse=True)
    assert set(jobs[0]) == {'job_id', 'created_at', 'submitted_from', 'execution_mode', 'status', 'item_count', 'completed_count', 'failed_count'}
    assert client.get('/api/v1/jobs/' + phone['job_id']).get_json()['submitted_from'] == 'mobile'


def test_completed_jobs_remain_discoverable_and_summaries_have_progress(coordinator):
    client, manager = coordinator
    job = submit(client, 'mobile')
    with manager.lock:
        stored = manager.jobs[job['job_id']]
        stored['status'] = 'completed'
        stored['items'][0]['state'] = 'completed'
    row = client.get('/api/v1/jobs').get_json()['jobs'][0]
    assert row['status'] == 'completed'
    assert row['item_count'] == row['completed_count'] == 1
    assert row['failed_count'] == 0
    with manager.lock:
        stored['status'] = 'failed'
        stored['items'][0]['state'] = 'failed'
    row = client.get('/api/v1/jobs').get_json()['jobs'][0]
    assert row['completed_count'] == 0 and row['failed_count'] == 1


def test_feed_is_bounded_but_older_job_details_remain_accessible(coordinator):
    client, manager = coordinator
    ids = []
    for index in range(55):
        job = submit(client, 'mobile' if index % 2 else 'web')
        ids.append(job['job_id'])
        with manager.lock:
            manager.jobs[job['job_id']]['created_at'] = index
    rows = client.get('/api/v1/jobs').get_json()['jobs']
    assert len(rows) == 50
    assert [row['job_id'] for row in rows] == list(reversed(ids[5:]))
    assert client.get('/api/v1/jobs/' + ids[0]).status_code == 200
    with manager.lock:
        manager.jobs.clear()
    assert client.get('/api/v1/jobs').get_json() == {'jobs': []}
    assert client.get('/api/v1/jobs/' + ids[0]).status_code == 404


def test_summary_snapshots_are_consistent_during_concurrent_updates(coordinator):
    client, manager = coordinator
    job = submit(client)
    with manager.lock:
        stored = manager.jobs[job['job_id']]
        stored['items'].append(dict(stored['items'][0], id='1'))
    stop = threading.Event()
    def writer():
        while not stop.is_set():
            for state in ('completed', 'failed'):
                with manager.lock:
                    for item in stored['items']:
                        item['state'] = state
    thread = threading.Thread(target=writer)
    thread.start()
    try:
        for _ in range(25):
            row = client.get('/api/v1/jobs').get_json()['jobs'][0]
            assert (row['completed_count'], row['failed_count']) in {(2, 0), (0, 2)}
    finally:
        stop.set()
        thread.join(timeout=2)
    assert not thread.is_alive()
