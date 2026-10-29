import io
import json
import os
import threading
import time
from types import SimpleNamespace

from edge_mesh.mobile_workers import MobileWorkers
from edge_mesh.cloud_fallback import CloudFallback
from edge_mesh.jobs import JobManager
from edge_mesh.peers import PeerManager
from edge_mesh.scheduler import score
from scripts.cleanup_data import cleanup
from edge_mesh.app import create_app
from edge_mesh.config import Config
from io import BytesIO
from PIL import Image
from werkzeug.datastructures import FileStorage


def test_memory_availability_changes_node_score():
    peer = {"cpu_percent": 20, "rtt_ms": 10, "success_rate": 1, "capacity": 2}
    assert score({**peer, "free_memory_ratio": 0.9}) > score({**peer, "free_memory_ratio": 0.1})


def test_reliability_survives_peer_manager_restart(tmp_path):
    path = str(tmp_path / "stats.json")
    manager = PeerManager(None, stats_path=path)
    manager.record_result("node-a", True)
    manager.record_result("node-a", False)
    restarted = PeerManager(None, stats_path=path)
    assert restarted.success_rate("node-a") == 0.5


def test_mobile_worker_reliability_uses_persisted_node_history(tmp_path):
    class Discovery:
        def list_peers(self):
            return []

    manager = PeerManager(Discovery(), stats_path=str(tmp_path / "stats.json"))
    worker_id = manager.mobile_workers.register("Phone", client_id="b" * 32)
    manager.record_result(worker_id, False)
    mobile = [peer for peer in manager.snapshot() if peer["source"] == "mobile"]
    assert mobile[0]["success_rate"] == 0


def test_mobile_worker_receives_input_and_returns_result():
    workers = MobileWorkers()
    worker_id = workers.register("Phone")
    result_holder = {}

    def execute():
        result_holder["value"] = workers.execute(worker_id, {
            "filename": "sample.jpg", "max_width": 100, "max_height": 100,
            "data": b"image-data",
        })

    thread = threading.Thread(target=execute)
    thread.start()
    task = None
    deadline = time.time() + 2
    while task is None and time.time() < deadline:
        task = workers.next_task(worker_id)
        if task is None:
            time.sleep(0.01)
    assert task is not None
    assert workers.task_input(worker_id, task["task_id"]) == b"image-data"
    expected = {"data": b"resized", "size": [50, 50], "format": "JPEG", "processing_ms": 5}
    assert workers.complete(worker_id, task["task_id"], expected)
    thread.join(timeout=2)
    assert result_holder["value"] == expected


def test_mobile_worker_id_is_stable_for_persisted_device_identity():
    workers = MobileWorkers()
    first = workers.register("Phone", client_id="a" * 32)
    second = workers.register("Phone", client_id="a" * 32)
    assert first == second


def test_job_manager_distributes_and_aggregates_phone_work(tmp_path):
    class Manager:
        def __init__(self):
            self.mobile_workers = MobileWorkers()
            self.worker_id = self.mobile_workers.register("Phone")

        def snapshot(self):
            return self.mobile_workers.snapshot()

        def record_result(self, node_id, success):
            pass

    peers = Manager()
    jobs = JobManager(str(tmp_path / "edge_mesh_data"), peers, 5000, "token")
    source = BytesIO()
    Image.new("RGB", (120, 80), "white").save(source, format="PNG")
    source.seek(0)
    job = jobs.create_job([FileStorage(stream=source, filename="phone.png")], 60, 60)
    task = None
    deadline = time.time() + 3
    while task is None and time.time() < deadline:
        task = peers.mobile_workers.next_task(peers.worker_id)
        if task is None:
            time.sleep(0.01)
    assert task is not None
    assert peers.mobile_workers.task_input(peers.worker_id, task["task_id"])
    output = BytesIO()
    Image.new("RGB", (60, 40), "white").save(output, format="JPEG")
    assert peers.mobile_workers.complete(peers.worker_id, task["task_id"], {
        "data": output.getvalue(), "size": [60, 40], "format": "JPEG", "processing_ms": 3,
    })
    deadline = time.time() + 3
    status = jobs.get(job["job_id"])
    while status["status"] not in {"completed", "failed"} and time.time() < deadline:
        time.sleep(0.01)
        status = jobs.get(job["job_id"])
    assert status["status"] == "completed"
    item = status["items"][0]
    assert item["execution_location"] == "mobile"
    assert item["assigned_node"] == "Phone"


def test_mobile_worker_http_api_checks_token_and_reports_peer(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    app, _ = create_app(Config(name="Coordinator", token="shared", port=5100))
    client = app.test_client()
    denied = client.post("/api/v1/mobile/workers/register", json={"name": "Test phone"})
    assert denied.status_code == 401
    registered = client.post(
        "/api/v1/mobile/workers/register", json={
            "name": "Test phone", "platform": "ios", "total_memory_mb": 4096,
            "free_memory_mb": 2048,
        }, headers={"X-Edge-Token": "shared"},
    )
    assert registered.status_code == 201
    worker_id = registered.get_json()["worker_id"]
    idle = client.get(
        f"/api/v1/mobile/workers/{worker_id}/tasks/next?cpu_percent=0&free_memory_mb=2048&total_memory_mb=4096",
        headers={"X-Edge-Token": "shared"},
    )
    assert idle.status_code == 204
    phones = [peer for peer in client.get("/api/v1/peers").get_json() if peer["source"] == "mobile"]
    assert phones[0]["platform"] == "ios"
    assert phones[0]["free_memory_ratio"] == 0.5


def test_cleanup_removes_only_old_job_folders(tmp_path):
    root = tmp_path / "edge_mesh_data"
    old = root / "old-job"
    fresh = root / "fresh-job"
    old.mkdir(parents=True)
    fresh.mkdir()
    os.utime(old, (time.time() - 10 * 86400, time.time() - 10 * 86400))
    (root / "node_stats.json").write_text("{}", encoding="utf-8")
    assert cleanup(root, 7, dry_run=True) == ["old-job"]
    assert old.exists()
    assert cleanup(root, 7) == ["old-job"]
    assert not old.exists() and fresh.exists()


def test_cloud_fallback_stages_large_task_by_object_key(monkeypatch):
    storage = {}
    deleted = []

    class S3:
        def put_object(self, Bucket, Key, Body):
            storage[Key] = Body

        def get_object(self, Bucket, Key):
            return {"Body": io.BytesIO(storage[Key])}

        def delete_objects(self, Bucket, Delete):
            for obj in Delete["Objects"]:
                deleted.append(obj["Key"])
                storage.pop(obj["Key"], None)
            return {}

    class Lambda:
        def invoke(self, FunctionName, InvocationType, Payload):
            event = json.loads(Payload)
            storage[event["output_key"]] = b"resized-image"
            return {"Payload": io.BytesIO(json.dumps({
                "statusCode": 200, "size": [80, 60], "format": "JPEG", "processing_ms": 12,
            }).encode())}

    fake_sdk = SimpleNamespace(client=lambda service, **kwargs: S3() if service == "s3" else Lambda())
    monkeypatch.setitem(__import__("sys").modules, "boto3", fake_sdk)
    result = CloudFallback("test-region", "worker", "private-bucket").execute(
        b"source-image", "source.jpg", 80, 60
    )
    assert result == (b"resized-image", [80, 60], "JPEG", 12)
    assert not storage
    assert len(deleted) == 2
