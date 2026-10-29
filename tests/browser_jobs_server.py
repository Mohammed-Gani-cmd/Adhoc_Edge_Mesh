"""Loopback-only, temporary coordinator for the browser job-discovery checks."""
import copy
import sys
import tempfile
import os
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from flask import jsonify, render_template, request
from edge_mesh.app import create_app
from edge_mesh.config import Config


def main():
    with tempfile.TemporaryDirectory(prefix='edge-mesh-browser-jobs-') as folder:
        os.chdir(folder)
        app, _ = create_app(Config(name='Browser test coordinator', port=5505))
        manager = app.config['EDGE_JOBS']

        @app.get('/__test__/legacy')
        def legacy():
            return render_template('dashboard.html')

        @app.post('/__test__/reset')
        def reset():
            with manager.lock:
                manager.jobs.clear()
            return jsonify(status='reset')

        @app.post('/__test__/age')
        def age():
            job_id = request.get_json()['job_id']
            with manager.lock:
                manager.jobs[job_id]['created_at'] = 1
                for index in range(55):
                    job = copy.deepcopy(manager.jobs[job_id])
                    job['job_id'] = f'extra-{index:03d}'
                    job['created_at'] = 100 + index
                    manager.jobs[job['job_id']] = job
            return jsonify(status='aged')

        @app.post('/__test__/s3')
        def s3_state():
            data = request.get_json()
            with manager.lock:
                job = manager.jobs[data['job_id']]
                job['execution_mode'] = 'cloud'
                job['s3_result'] = {
                    'status': data['status'],
                    'bucket': 'browser-test-bucket' if data['status'] == 'saved' else None,
                    'key': f"edge-mesh/tasks/results/{data['job_id']}/results.zip" if data['status'] == 'saved' else None,
                    'error': 'Could not save results to S3; local ZIP remains available' if data['status'] == 'failed' else None,
                }
            return jsonify(status=data['status'])

        app.run(host='127.0.0.1', port=5505, threaded=True, use_reloader=False)


if __name__ == '__main__':
    main()
