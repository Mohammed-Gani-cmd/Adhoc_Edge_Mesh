"""Run one isolated scheduler demo with a simulated edge failure and real AWS fallback.

From the project root: python -m scripts.demo_cloud_fallback --live
"""
import argparse
import json
import os
import time
import zipfile
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image
from werkzeug.datastructures import FileStorage

import edge_mesh.jobs as jobs_module
from edge_mesh.cloud_fallback import CloudFallback
from edge_mesh.config import Config
from edge_mesh.jobs import JobManager


ROOT = Path(__file__).resolve().parents[1]
CLOUD_SETTINGS = {'AWS_PROFILE', 'AWS_REGION', 'EDGE_LAMBDA_FUNCTION', 'EDGE_S3_BUCKET', 'EDGE_CLOUD_ENABLED'}


def load_local_cloud_settings():
    """Load only the deployment names written for this laptop; never load keys."""
    path = ROOT / '.env.aws'
    if not path.exists():
        return
    for raw in path.read_text(encoding='utf-8').splitlines():
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        name, separator, value = line.partition('=')
        if separator and name.strip() in CLOUD_SETTINGS:
            os.environ.setdefault(name.strip(), value.strip())


class SimulatedFailingEdge:
    def snapshot(self):
        return [{'node_id': 'local', 'name': 'Simulated laptop', 'source': 'local',
                 'online': True, 'capacity': 1}]

    def record_result(self, node_id, success):
        pass


def simulated_resize_failure(*args):
    raise RuntimeError('Simulated local resize failure for cloud demo')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live', action='store_true', help='Invoke AWS once for a tiny PNG after the simulated local failure')
    args = parser.parse_args()
    if not args.live:
        parser.error('Pass --live to run the one-image AWS fallback demo')

    load_local_cloud_settings()
    try:
        cfg = Config()
        cfg.validate_cloud()
    except ValueError as exc:
        parser.error(str(exc))
    if not cfg.cloud_enabled:
        parser.error('Enable AWS fallback before running this demo')

    source = BytesIO()
    Image.new('RGB', (16, 8), 'white').save(source, format='PNG')
    source.seek(0)
    cloud = CloudFallback(cfg.aws_region, cfg.lambda_function_name, cfg.s3_bucket)
    original_resize = jobs_module.resize_image
    try:
        # This process alone simulates a failed laptop. The running coordinator
        # and its normal edge-first scheduling are unchanged.
        jobs_module.resize_image = simulated_resize_failure
        with TemporaryDirectory(prefix='edge-mesh-cloud-demo-') as temporary:
            manager = JobManager(Path(temporary), SimulatedFailingEdge(), 5000, cfg.token, cloud_fallback=cloud)
            # Exercise the historical fallback sequence explicitly. Normal
            # coordinator jobs now use one mode for their whole lifetime.
            manager._run = lambda job_id: None
            job = manager.create_job([FileStorage(stream=source, filename='cloud-demo.png')], 8, 8)
            live = manager._get_ref(job['job_id'])
            item = live['items'][0]
            if manager._execute(live, item, manager.peer_manager.snapshot()[0]):
                parser.exit(1, 'Simulated laptop unexpectedly completed the image.\n')
            live['status'] = 'completed' if manager._execute_cloud(live, item) else 'failed'
            result = manager.get(job['job_id'])

            item = result['items'][0]
            if (result['status'] != 'completed' or item['execution_location'] != 'cloud'
                    or [attempt['status'] for attempt in item['attempts']] != ['failed', 'completed']
                    or item['output_size'] != [8, 4]):
                parser.exit(1, f"Cloud demo failed: {item.get('error') or result.get('error')}\n")

            archive = ROOT / 'edge_mesh_data' / 'cloud_demo_results.zip'
            archive.parent.mkdir(parents=True, exist_ok=True)
            archive.write_bytes(manager.make_zip(job['job_id']).getvalue())
            with zipfile.ZipFile(archive) as z:
                manifest = json.loads(z.read('manifest.json'))
                if manifest['items'][0]['execution_location'] != 'cloud':
                    parser.exit(1, 'Cloud demo ZIP did not record AWS execution.\n')
            print('Cloud fallback demonstrated: simulated laptop failure -> AWS Lambda success (8 x 4 PNG).')
            print(f'Result ZIP: {archive}')
            print('This isolated demo does not appear in the running dashboard.')
    finally:
        jobs_module.resize_image = original_resize


if __name__ == '__main__':
    main()
