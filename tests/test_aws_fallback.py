"""AWS behavior without credentials, network calls, or deployed resources."""
import importlib.util
import json
import sys
import time
import zipfile
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace

import boto3
import pytest
from PIL import Image
from werkzeug.datastructures import FileStorage

from edge_mesh.app import create_app, main
from edge_mesh.cloud_fallback import CloudFallback
from edge_mesh.config import Config
from edge_mesh.jobs import JobManager


@pytest.fixture(autouse=True)
def isolated_cloud_environment(monkeypatch):
    for key in ('EDGE_CLOUD_ENABLED', 'EDGE_LAMBDA_FUNCTION', 'EDGE_S3_BUCKET', 'AWS_REGION', 'AWS_DEFAULT_REGION'):
        monkeypatch.delenv(key, raising=False)


def image_bytes(fmt='PNG', size=(120, 80), rotate=False):
    out = BytesIO()
    exif = Image.Exif()
    if rotate:
        exif[274] = 6
    Image.new('RGB', size, 'white').save(out, format=fmt, exif=exif)
    return out.getvalue()


def test_cloud_is_opt_in_even_with_all_resource_settings(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv('EDGE_LAMBDA_FUNCTION', 'worker')
    monkeypatch.setenv('EDGE_S3_BUCKET', 'staging')
    monkeypatch.setattr(boto3, 'client', lambda *a, **k: pytest.fail('Disabled cloud contacted AWS'))
    app, _ = create_app()
    assert app.test_client().get('/api/v1/status').json['cloud_fallback_enabled'] is False


def test_enabled_configuration_is_read_when_config_is_created(monkeypatch):
    assert Config().aws_region == 'ap-south-1'
    monkeypatch.setenv('EDGE_CLOUD_ENABLED', 'true')
    monkeypatch.setenv('EDGE_LAMBDA_FUNCTION', 'worker')
    monkeypatch.setenv('EDGE_S3_BUCKET', 'staging')
    cfg = Config()
    cfg.validate_cloud()
    assert cfg.cloud_enabled
    monkeypatch.setenv('EDGE_CLOUD_ENABLED', 'false')
    assert not Config().cloud_enabled


@pytest.mark.parametrize('missing', ['aws_region', 'lambda_function_name', 's3_bucket'])
def test_enabled_cloud_rejects_missing_settings_before_startup(missing):
    kwargs = dict(cloud_enabled=True, aws_region='ap-south-1', lambda_function_name='worker', s3_bucket='staging')
    kwargs[missing] = ''
    with pytest.raises(ValueError, match='AWS fallback is enabled but missing'):
        create_app(Config(**kwargs))


def test_invalid_enable_flag_is_not_silently_ignored(monkeypatch):
    monkeypatch.setenv('EDGE_CLOUD_ENABLED', 'treu')
    with pytest.raises(ValueError, match='EDGE_CLOUD_ENABLED must be true or false'):
        Config()


def test_cli_explains_incomplete_cloud_configuration(monkeypatch, capsys):
    monkeypatch.setenv('EDGE_CLOUD_ENABLED', 'true')
    monkeypatch.setattr(sys, 'argv', ['edge_mesh'])
    with pytest.raises(SystemExit) as exc:
        main()
    assert exc.value.code == 2
    assert 'EDGE_LAMBDA_FUNCTION, EDGE_S3_BUCKET' in capsys.readouterr().err


@pytest.fixture
def aws(monkeypatch):
    storage = {}
    deleted = []
    clients = {}

    class S3:
        def put_object(self, Bucket, Key, Body, **kwargs):
            storage[Key] = Body

        def get_object(self, Bucket, Key):
            return {'Body': BytesIO(storage[Key])}

        def delete_objects(self, Bucket, Delete):
            for obj in Delete['Objects']:
                deleted.append(obj['Key'])
                storage.pop(obj['Key'], None)
            return {}

    s3 = S3()
    lam = SimpleNamespace()

    def client(service, **kwargs):
        clients[service] = kwargs
        return s3 if service == 's3' else lam

    monkeypatch.setattr(boto3, 'client', client)
    monkeypatch.setenv('EDGE_STAGING_BUCKET', 'staging')
    path = Path(__file__).resolve().parents[1] / 'lambda_worker' / 'app.py'
    spec = importlib.util.spec_from_file_location('test_lambda_worker', path)
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)

    def invoke(**kwargs):
        result = worker.handler(json.loads(kwargs['Payload']), None)
        return {'Payload': BytesIO(json.dumps(result).encode())}

    lam.invoke = invoke
    return SimpleNamespace(storage=storage, deleted=deleted, s3=s3, lam=lam,
                           worker=worker, clients=clients,
                           cloud=CloudFallback('ap-south-1', 'worker', 'staging'))


@pytest.mark.parametrize('fmt,size,rotate,expected', [
    ('PNG', (120, 80), False, [60, 40]),
    ('JPEG', (120, 80), False, [60, 40]),
    ('WEBP', (120, 80), False, [60, 40]),
    ('PNG', (12, 8), False, [12, 8]),
    ('JPEG', (120, 80), True, [40, 60]),
])
def test_adapter_and_lambda_resize_and_cleanup(aws, fmt, size, rotate, expected):
    output, actual, output_fmt, ms = aws.cloud.execute(image_bytes(fmt, size, rotate), 'image', 60, 60)
    with Image.open(BytesIO(output)) as image:
        assert list(image.size) == actual == expected
        assert image.format == output_fmt == fmt
    assert ms >= 0
    assert not aws.storage
    assert len(aws.deleted) == 2
    config = aws.clients['lambda']['config']
    assert config.read_timeout > 60
    assert config.retries['total_max_attempts'] == 1


@pytest.mark.parametrize('failure', ['input', 'invoke', 'function', 'worker', 'download', 'payload'])
def test_aws_errors_cleanup_both_objects_and_keep_original_error(aws, monkeypatch, failure):
    def fail(**kwargs):
        raise RuntimeError('AWS unavailable')

    if failure == 'input':
        monkeypatch.setattr(aws.s3, 'put_object', fail)
    elif failure == 'invoke':
        monkeypatch.setattr(aws.lam, 'invoke', fail)
    elif failure == 'download':
        monkeypatch.setattr(aws.s3, 'get_object', fail)
    elif failure == 'payload':
        monkeypatch.setattr(aws.lam, 'invoke', lambda **kw: {'Payload': BytesIO(b'bad-json')})
    else:
        response = {'errorMessage': 'AWS unavailable'} if failure == 'function' else {'statusCode': 400, 'error': 'AWS unavailable'}
        monkeypatch.setattr(aws.lam, 'invoke', lambda **kw: {
            'FunctionError': failure == 'function', 'Payload': BytesIO(json.dumps(response).encode()),
        })
    with pytest.raises((RuntimeError, json.JSONDecodeError)):
        aws.cloud.execute(image_bytes(), 'image.png', 60, 60)
    assert not aws.storage
    assert len(aws.deleted) == 2


@pytest.mark.parametrize('exception', [False, True])
def test_cleanup_failure_does_not_discard_a_valid_result(aws, monkeypatch, caplog, exception):
    def cleanup(**kwargs):
        if exception:
            raise RuntimeError('cleanup unavailable')
        return {'Errors': [{'Code': 'AccessDenied'}]}

    monkeypatch.setattr(aws.s3, 'delete_objects', cleanup)
    assert aws.cloud.execute(image_bytes(), 'image.png', 60, 60)[1] == [60, 40]
    assert 'AWS task cleanup' in caplog.text
    assert len(aws.storage) == 2


class Peers:
    def __init__(self):
        self.nodes = [{'node_id': 'local', 'name': 'Laptop', 'source': 'local', 'online': True, 'capacity': 1}]

    def snapshot(self):
        return self.nodes

    def record_result(self, node_id, success):
        pass


def queued_job(tmp_path, monkeypatch, cloud, peers=None, mode='mesh'):
    jobs = JobManager(tmp_path / 'data', peers or Peers(), 5000, 'token', cloud_fallback=cloud)
    monkeypatch.setattr(jobs, '_run', lambda job_id: None)
    jobs.set_execution_mode(mode)
    job = jobs.create_job([FileStorage(stream=BytesIO(image_bytes()), filename='image.png')], 60, 60)
    return jobs, job['job_id']


def test_busy_edge_waits_beyond_old_timeout_then_finishes_locally(tmp_path, monkeypatch):
    cloud = SimpleNamespace(execute=lambda *a: pytest.fail('Busy edge invoked AWS'))
    jobs, job_id = queued_job(tmp_path, monkeypatch, cloud)
    jobs.inflight['local'] = 1
    clock = [0]

    def sleep(seconds):
        clock[0] += seconds
        if clock[0] >= 8:
            jobs.inflight['local'] = 0

    monkeypatch.setattr('edge_mesh.jobs.time', SimpleNamespace(
        sleep=sleep, monotonic=lambda: clock[0], time=time.time, perf_counter=time.perf_counter))
    JobManager._run(jobs, job_id)
    job = jobs.get(job_id)
    assert clock[0] >= 8
    assert job['status'] == 'completed'
    assert job['items'][0]['execution_location'] == 'local'


def test_changed_peer_set_still_waits_for_untried_busy_worker(tmp_path, monkeypatch):
    cloud = SimpleNamespace(execute=lambda *a: pytest.fail('Untried busy edge invoked AWS'))
    peers = Peers()
    jobs, job_id = queued_job(tmp_path, monkeypatch, cloud, peers)
    calls = []

    def execute(job, item, node):
        calls.append(node['node_id'])
        if node['node_id'] == 'local':
            peers.nodes = [{'node_id': 'new-worker', 'online': True, 'capacity': 1, 'in_flight': 1}]
            return False
        return True

    def sleep(seconds):
        peers.nodes[0]['in_flight'] = 0

    monkeypatch.setattr(jobs, '_execute', execute)
    monkeypatch.setattr('edge_mesh.jobs.time', SimpleNamespace(sleep=sleep))
    assert jobs._process_item(job_id, '0')
    assert calls == ['local', 'new-worker']


def test_mesh_never_uses_aws_after_all_available_edge_attempts_fail(tmp_path, monkeypatch):
    peers = Peers()
    peers.nodes.append({'node_id': 'laptop-2', 'name': 'Laptop-2', 'source': 'manual',
                        'online': True, 'capacity': 1})
    jobs, job_id = queued_job(tmp_path, monkeypatch, SimpleNamespace(), peers)
    attempts = []

    def local(job, item, node):
        attempts.append(node['node_id'])
        return False

    def cloud(job, item):
        attempts.append('cloud')
        return True

    monkeypatch.setattr(jobs, '_execute', local)
    monkeypatch.setattr(jobs, '_execute_cloud', cloud)
    assert not jobs._process_item(job_id, '0')
    assert set(attempts[:2]) == {'local', 'laptop-2'}
    assert 'cloud' not in attempts


def test_cloud_goes_directly_to_aws_and_records_manifest(aws, tmp_path, monkeypatch):
    jobs, job_id = queued_job(tmp_path, monkeypatch, aws.cloud, mode='cloud')
    monkeypatch.setattr('edge_mesh.jobs.resize_image', lambda *a: pytest.fail('Cloud job used mesh'))
    JobManager._run(jobs, job_id)
    job = jobs.get(job_id)
    assert job['status'] == 'completed'
    item = job['items'][0]
    assert [a['status'] for a in item['attempts']] == ['completed']
    assert item['execution_location'] == 'cloud'
    with zipfile.ZipFile(jobs.make_zip(job_id)) as archive:
        manifest = json.loads(archive.read('manifest.json'))['items'][0]
        assert manifest['assigned_node'] == 'AWS Lambda'
        assert manifest['execution_location'] == 'cloud'
        assert manifest['attempts'] == 1
    saved = job['s3_result']
    assert saved == {'status': 'saved', 'bucket': 'staging',
                     'key': f'edge-mesh/tasks/results/{job_id}/results.zip', 'error': None}
    with zipfile.ZipFile(BytesIO(aws.storage[saved['key']])) as archive:
        assert archive.namelist() == [item['output_name'], 'manifest.json']
    assert set(aws.storage) == {saved['key']}


def test_partial_cloud_job_saves_successful_results(aws, tmp_path, monkeypatch):
    jobs = JobManager(tmp_path / 'data', Peers(), 5000, 'token', cloud_fallback=aws.cloud)
    monkeypatch.setattr(jobs, '_run', lambda job_id: None)
    jobs.set_execution_mode('cloud')
    created = jobs.create_job([
        FileStorage(stream=BytesIO(image_bytes()), filename='good.png'),
        FileStorage(stream=BytesIO(image_bytes()), filename='bad.png'),
    ], 60, 60)
    original = aws.cloud.execute
    monkeypatch.setattr(aws.cloud, 'execute', lambda data, name, width, height:
                        original(data, name, width, height) if name == 'good.png'
                        else (_ for _ in ()).throw(RuntimeError('worker failed')))
    JobManager._run(jobs, created['job_id'])
    result = jobs.get(created['job_id'])
    assert result['status'] == 'failed'
    assert result['s3_result']['status'] == 'saved'
    with zipfile.ZipFile(BytesIO(aws.storage[result['s3_result']['key']])) as archive:
        assert archive.namelist() == ['good_0.png', 'manifest.json']


def test_s3_save_failure_keeps_cloud_job_and_local_zip(aws, tmp_path, monkeypatch):
    jobs, job_id = queued_job(tmp_path, monkeypatch, aws.cloud, mode='cloud')
    monkeypatch.setattr(aws.cloud, 'save_results_zip', lambda *_: (_ for _ in ()).throw(RuntimeError('AccessDenied')))
    JobManager._run(jobs, job_id)
    result = jobs.get(job_id)
    assert result['status'] == 'completed'
    assert result['s3_result']['status'] == 'failed'
    assert 'local ZIP remains available' in result['s3_result']['error']
    with zipfile.ZipFile(jobs.make_zip(job_id)) as archive:
        assert 'manifest.json' in archive.namelist()


def test_no_workers_fails_mesh_after_discovery_without_aws(aws, tmp_path, monkeypatch):
    peers = Peers()
    peers.nodes = []
    jobs, job_id = queued_job(tmp_path, monkeypatch, aws.cloud, peers)
    clock = [0]
    monkeypatch.setattr('edge_mesh.jobs.time', SimpleNamespace(
        monotonic=lambda: clock[0], sleep=lambda seconds: clock.__setitem__(0, clock[0] + seconds),
        time=time.time, perf_counter=time.perf_counter))
    JobManager._run(jobs, job_id)
    assert clock[0] == 10
    job = jobs.get(job_id)
    assert job['status'] == 'failed'
    assert len(job['items'][0]['attempts']) == 0


@pytest.mark.parametrize('cloud_result', [None, (b'not-an-image', [60, 40], 'PNG', 1),
                                        (image_bytes(size=(120, 80)), [120, 80], 'PNG', 1)])
def test_cloud_failure_is_visible_in_job_history(tmp_path, monkeypatch, cloud_result):
    def execute(*args):
        if cloud_result is None:
            raise RuntimeError('AWS access denied')
        return cloud_result

    jobs, job_id = queued_job(tmp_path, monkeypatch, SimpleNamespace(execute=execute), mode='cloud')
    monkeypatch.setattr('edge_mesh.jobs.resize_image', lambda *a: pytest.fail('Cloud job used mesh'))
    JobManager._run(jobs, job_id)
    job = jobs.get(job_id)
    assert job['status'] == 'failed'
    assert len(job['items'][0]['attempts']) == 1
    assert job['s3_result']['status'] == 'skipped'
    assert job['items'][0]['attempts'][-1]['status'] == 'failed'
    assert 'Cloud processing failed' in job['items'][0]['error']
    assert not list((jobs.base / job_id / 'output').iterdir())


def test_offline_check_never_contacts_aws(monkeypatch, capsys):
    from scripts.check_aws import main as check
    monkeypatch.setattr(sys, 'argv', ['check_aws'])
    monkeypatch.setattr(boto3, 'client', lambda *a, **k: pytest.fail('Offline check contacted AWS'))
    check()
    assert 'No AWS calls made' in capsys.readouterr().out


def test_live_check_requires_explicit_cloud_enable(monkeypatch):
    from scripts.check_aws import main as check
    monkeypatch.setattr(sys, 'argv', ['check_aws', '--live'])
    with pytest.raises(SystemExit) as exc:
        check()
    assert exc.value.code == 2


def test_explicit_live_check_resizes_tiny_image_with_mock_aws(aws, monkeypatch, capsys):
    from scripts.check_aws import main as check
    monkeypatch.setenv('EDGE_CLOUD_ENABLED', 'true')
    monkeypatch.setenv('EDGE_LAMBDA_FUNCTION', 'worker')
    monkeypatch.setenv('EDGE_S3_BUCKET', 'staging')
    monkeypatch.setattr(sys, 'argv', ['check_aws', '--live'])
    check()
    assert 'Live AWS resize passed' in capsys.readouterr().out
    assert not aws.storage
