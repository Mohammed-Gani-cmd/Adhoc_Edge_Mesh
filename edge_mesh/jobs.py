import io
import json
import logging
import os
import threading
import time
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests
from PIL import Image

from .image_processor import resize_image
from .scheduler import choose_node

logger = logging.getLogger(__name__)


class JobManager:
    """Coordinates image tasks across the local edge mesh.

    Important implementation detail: worker threads always mutate the live job
    stored in ``self.jobs``. Public ``get()`` returns a deep copy for safe JSON
    serialization, but internal scheduling never works on a copy.
    """

    def __init__(self, base_dir, peer_manager, local_port, token, max_workers=12, cloud_fallback=None):
        self.base = Path(base_dir)
        self.base.mkdir(parents=True, exist_ok=True)
        self.peer_manager = peer_manager
        self.local_port = local_port
        self.token = token
        self.jobs = {}
        self.lock = threading.RLock()
        self.allocation_lock = threading.Lock()
        self.inflight = {}
        self.max_workers = max_workers
        self.cloud_fallback = cloud_fallback
        self.execution_mode = "mesh"

    def get_execution_mode(self):
        with self.lock:
            return self.execution_mode

    def set_execution_mode(self, mode):
        if mode not in {"mesh", "cloud"}:
            raise ValueError("Execution mode must be mesh or cloud")
        if mode == "cloud" and self.cloud_fallback is None:
            raise RuntimeError("AWS is not configured on this coordinator")
        with self.lock:
            self.execution_mode = mode

    def create_job(self, files, max_width, max_height, submitted_from="unknown"):
        job_id = uuid.uuid4().hex[:10]
        jobdir = self.base / job_id
        (jobdir / "input").mkdir(parents=True)
        (jobdir / "output").mkdir(parents=True)

        items = []
        for idx, f in enumerate(files):
            data = f.read()
            name = os.path.basename(f.filename or f"image-{idx}.jpg")
            stored = f"{idx:03d}_{name}"
            (jobdir / "input" / stored).write_bytes(data)
            items.append({
                "id": str(idx),
                "source_name": name,
                "stored_name": stored,
                "bytes": len(data),
                "state": "queued",
                "attempts": [],
                "assigned_node": None,
                "execution_location": None,
                "output_name": None,
                "output_size": None,
                "processing_ms": None,
                "error": None,
            })

        job = {
            "job_id": job_id,
            "created_at": time.time(),
            "submitted_from": submitted_from if submitted_from in {"mobile", "web"} else "unknown",
            "execution_mode": None,
            "max_width": max_width,
            "max_height": max_height,
            "items": items,
            "status": "queued",
            "error": None,
            "duration": None,
            "node_contributions": {},
            "s3_result": None,
        }
        with self.lock:
            job["execution_mode"] = self.execution_mode
            if self.execution_mode == "cloud":
                job["s3_result"] = {"status": "pending", "bucket": None, "key": None, "error": None}
            self.jobs[job_id] = job

        # Start scheduling immediately, but never block the HTTP upload request.
        threading.Thread(target=self._run, args=(job_id,), daemon=True, name=f"job-{job_id}").start()
        return self.get(job_id)

    def _get_ref(self, job_id):
        with self.lock:
            return self.jobs.get(job_id)

    def _node_list(self):
        return self.peer_manager.snapshot()

    def _execute(self, job, item, node):
        path = self.base / job["job_id"] / "input" / item["stored_name"]
        data = path.read_bytes()
        started = time.perf_counter()
        attempt = {
            "node": node["name"],
            "node_id": node["node_id"],
            "location": node.get("source", "local"),
            "started_at": time.time(),
            "status": "running",
        }
        with self.lock:
            item["attempts"].append(attempt)
            item["assigned_node"] = node["name"]
            item["state"] = "processing"
            item["error"] = None

        try:
            if node["node_id"] == "local":
                out, size, fmt, _ = resize_image(
                    data, item["source_name"], job["max_width"], job["max_height"]
                )
                processing_ms = round((time.perf_counter() - started) * 1000, 2)
            elif node.get("source") == "mobile":
                result = self.peer_manager.mobile_workers.execute(node["node_id"], {
                    "job_id": job["job_id"], "item_id": item["id"],
                    "filename": item["source_name"], "max_width": job["max_width"],
                    "max_height": job["max_height"], "data": data,
                })
                out, size, fmt, processing_ms = result["data"], result["size"], result["format"], result["processing_ms"]
            else:
                response = requests.post(
                    f"http://{node['host']}:{node['port']}/api/v1/tasks/resize",
                    files={"image": (item["source_name"], data)},
                    data={
                        "max_width": job["max_width"],
                        "max_height": job["max_height"],
                    },
                    headers={"X-Edge-Token": self.token},
                    timeout=(2, 60),
                )
                response.raise_for_status()
                out = response.content
                size = [
                    int(response.headers["X-Output-Width"]),
                    int(response.headers["X-Output-Height"]),
                ]
                fmt = response.headers.get("X-Output-Format", "JPEG")
                processing_ms = float(
                    response.headers.get(
                        "X-Processing-Ms",
                        (time.perf_counter() - started) * 1000,
                    )
                )

            if not out or size[0] <= 0 or size[1] <= 0:
                raise ValueError("Worker returned invalid image output")

            ext = {"JPEG": "jpg", "PNG": "png", "WEBP": "webp"}.get(fmt, "jpg")
            outname = f"{Path(item['source_name']).stem}_{item['id']}.{ext}"
            (self.base / job["job_id"] / "output" / outname).write_bytes(out)
            duration_ms = round((time.time() - attempt["started_at"]) * 1000, 1)

            with self.lock:
                attempt.update(status="completed", duration_ms=duration_ms)
                item.update(
                    state="completed",
                    output_name=outname,
                    execution_location=node.get("source", "local"),
                    output_size=list(size),
                    processing_ms=processing_ms,
                    error=None,
                )
                job["node_contributions"][node["name"]] = (
                    job["node_contributions"].get(node["name"], 0) + 1
                )
            self.peer_manager.record_result(node["node_id"], True)
            return True

        except Exception as exc:
            duration_ms = round((time.time() - attempt["started_at"]) * 1000, 1)
            with self.lock:
                attempt.update(status="failed", error=str(exc), duration_ms=duration_ms)
                item.update(state="retrying", error=str(exc))
            self.peer_manager.record_result(node["node_id"], False)
            return False

    def _process_item(self, job_id, item_id):
        job = self._get_ref(job_id)
        if job is None:
            return False
        item = next((x for x in job["items"] if x["id"] == item_id), None)
        if item is None:
            return False

        if job["execution_mode"] == "cloud":
            return self._execute_cloud(job, item)

        attempted = set()
        no_node_since = None

        while True:
            peers = self._node_list()
            with self.allocation_lock:
                node = choose_node(peers, self.inflight, attempted)
                if node:
                    node_id = node["node_id"]
                    self.inflight[node_id] = self.inflight.get(node_id, 0) + 1

            if node:
                no_node_since = None
                attempted.add(node["node_id"])
                try:
                    if self._execute(job, item, node):
                        return True
                finally:
                    with self.allocation_lock:
                        self.inflight[node["node_id"]] = max(
                            0, self.inflight.get(node["node_id"], 1) - 1
                        )
                # A failed attempt is retried on a different node.
                continue

            # No capacity is currently free. Do not mark the task failed merely
            # because all workers are busy. Wait for one to become available.
            online_nodes = [p for p in peers if p.get("online", False)]
            if any(p['node_id'] not in attempted for p in online_nodes):
                # Busyness is not failure. Never spend cloud credits just
                # because an untried edge worker is still occupied.
                no_node_since = None
                time.sleep(0.15)
                continue

            # If every currently-online node has already been tried, the unit is
            # exhausted. If no nodes are visible, give discovery a short window.
            if not online_nodes:
                if no_node_since is None:
                    no_node_since = time.monotonic()
                if time.monotonic() - no_node_since < 10:
                    time.sleep(0.25)
                    continue

            with self.lock:
                item.update(state="failed", error="All eligible local nodes failed")
            return False

    def _execute_cloud(self, job, item):
        path = self.base / job["job_id"] / "input" / item["stored_name"]
        attempt = {"node": "AWS Lambda", "node_id": "cloud", "started_at": time.time(), "status": "running", "location": "cloud"}
        with self.lock:
            item["attempts"].append(attempt)
            item.update(state="processing", assigned_node="AWS Lambda", error=None)
        try:
            out, size, fmt, processing_ms = self.cloud_fallback.execute(
                path.read_bytes(), item["source_name"], job["max_width"], job["max_height"]
            )
            with Image.open(io.BytesIO(out)) as image:
                image.load()
                if (fmt not in {"JPEG", "PNG", "WEBP"} or image.format != fmt
                        or list(image.size) != list(size)
                        or not (0 < image.width <= job["max_width"])
                        or not (0 < image.height <= job["max_height"])):
                    raise ValueError("Cloud worker returned invalid image output")
            ext = {"JPEG": "jpg", "PNG": "png", "WEBP": "webp"}[fmt]
            outname = f"{Path(item['source_name']).stem}_{item['id']}.{ext}"
            (self.base / job["job_id"] / "output" / outname).write_bytes(out)
            with self.lock:
                attempt.update(status="completed", duration_ms=round((time.time() - attempt["started_at"]) * 1000, 1))
                item.update(state="completed", output_name=outname, output_size=list(size), processing_ms=processing_ms, execution_location="cloud", error=None)
                job["node_contributions"]["AWS Lambda"] = job["node_contributions"].get("AWS Lambda", 0) + 1
            return True
        except Exception as exc:
            with self.lock:
                attempt.update(status="failed", error=str(exc), duration_ms=round((time.time() - attempt["started_at"]) * 1000, 1))
                item.update(state="failed", error=f"Cloud processing failed: {exc}")
            return False

    def _run(self, job_id):
        started = time.perf_counter()
        job = self._get_ref(job_id)
        if job is None:
            return

        try:
            with self.lock:
                job["status"] = "running"
                job["error"] = None

            # Larger images first, as required by the project plan.
            ordered = sorted(job["items"], key=lambda x: x["bytes"], reverse=True)
            workers = min(self.max_workers, max(1, len(ordered)))

            with ThreadPoolExecutor(
                max_workers=workers, thread_name_prefix="edge-task"
            ) as pool:
                futures = [
                    pool.submit(self._process_item, job_id, item["id"])
                    for item in ordered
                ]
                results = [future.result() for future in as_completed(futures)]

            with self.lock:
                failed = any(not result for result in results)
                job["status"] = "failed" if failed else "completed"
                job["duration"] = round(time.perf_counter() - started, 2)
                if failed:
                    job["error"] = (
                        f"One or more images could not be completed in {job['execution_mode']} mode."
                    )
        except Exception as exc:
            with self.lock:
                job["status"] = "failed"
                job["duration"] = round(time.perf_counter() - started, 2)
                job["error"] = f"Scheduler error: {exc}"
                for item in job["items"]:
                    if item["state"] in {"queued", "processing", "retrying"}:
                        item["state"] = "failed"
                        item["error"] = str(exc)

        if job["execution_mode"] == "cloud":
            self._save_cloud_results(job_id)

    def _save_cloud_results(self, job_id):
        job = self._get_ref(job_id)
        if job is None:
            return
        with self.lock:
            if not any(item["state"] == "completed" for item in job["items"]):
                job["s3_result"].update(status="skipped", error="No completed images to save")
                return
            job["s3_result"]["status"] = "uploading"
        try:
            archive = self.make_zip(job_id)
            key = self.cloud_fallback.save_results_zip(job_id, archive.getvalue())
            with self.lock:
                job["s3_result"].update(status="saved", bucket=self.cloud_fallback.bucket,
                                        key=key, error=None)
        except Exception:
            logger.exception("Could not save Cloud results ZIP for job %s", job_id)
            with self.lock:
                job["s3_result"].update(status="failed", error="Could not save results to S3; local ZIP remains available")

    def get(self, job_id):
        with self.lock:
            job = self.jobs.get(job_id)
            if job is None:
                return None
            return json.loads(json.dumps(job))

    def list_recent(self):
        """Bounded discovery feed shared by all clients of this coordinator."""
        with self.lock:
            jobs = sorted(self.jobs.values(), key=lambda job: (job["created_at"], job["job_id"]), reverse=True)[:50]
            return [{
                "job_id": job["job_id"], "created_at": job["created_at"],
                "submitted_from": job.get("submitted_from", "unknown"),
                "execution_mode": job["execution_mode"],
                "status": job["status"], "item_count": len(job["items"]),
                "completed_count": sum(item["state"] == "completed" for item in job["items"]),
                "failed_count": sum(item["state"] == "failed" for item in job["items"]),
            } for job in jobs]

    def make_zip(self, job_id):
        job = self.get(job_id)
        if not job:
            return None
        mem = io.BytesIO()
        manifest = []
        with zipfile.ZipFile(mem, "w", zipfile.ZIP_DEFLATED) as z:
            outdir = self.base / job_id / "output"
            for item in job["items"]:
                if item["state"] == "completed":
                    z.write(outdir / item["output_name"], arcname=item["output_name"])
                    manifest.append(
                        {
                            "source_name": item["source_name"],
                            "output_size": item["output_size"],
                            "assigned_node": item["assigned_node"],
                            "execution_location": item.get("execution_location", "local"),
                            "attempts": len(item["attempts"]),
                            "processing_time_ms": item.get("processing_ms", 0),
                        }
                    )
            z.writestr(
                "manifest.json",
                json.dumps({"job_id": job_id, "items": manifest}, indent=2),
            )
        mem.seek(0)
        return mem
