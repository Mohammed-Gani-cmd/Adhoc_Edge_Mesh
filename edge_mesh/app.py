import argparse
import os
import time

import psutil
from io import BytesIO
from PIL import Image
from flask import Flask, jsonify, render_template, request, send_file, Response, send_from_directory

from .config import Config
from .cloud_fallback import CloudFallback
from .discovery import Discovery
from .image_processor import resize_image
from .jobs import JobManager
from .peers import PeerManager
from .scheduler import capacity_for
from .security import require_token


def create_app(cfg=None):
    cfg = cfg or Config()
    cfg.validate_cloud()
    cloud = None
    if cfg.cloud_enabled:
        cloud = CloudFallback(cfg.aws_region, cfg.lambda_function_name, cfg.s3_bucket)
    discovery = Discovery(cfg.name, cfg.port, cfg.protocol_version, cfg.service_type)
    peer_manager = PeerManager(discovery, cfg.name, cfg.port, protocol_version=cfg.protocol_version)
    jobs = JobManager("./edge_mesh_data", peer_manager, cfg.port, cfg.token, cloud_fallback=cloud)
    peer_manager.inflight = jobs.inflight
    started = time.time()

    frontend_dist = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "frontend", "dist"))
    app = Flask(__name__, template_folder="../templates", static_folder="../static")
    app.config["EDGE_DISCOVERY"] = discovery
    app.config["EDGE_PEERS"] = peer_manager
    app.config["EDGE_JOBS"] = jobs
    app.config["EDGE_CFG"] = cfg
    app.config["MAX_CONTENT_LENGTH"] = cfg.max_total_bytes + 4 * 1024 * 1024

    @app.get("/")
    def dashboard():
        # Prefer the React/Tailwind frontend when it has been built.
        # Fall back to the bundled HTML dashboard so the backend remains runnable
        # even before Node/npm is installed.
        index = os.path.join(frontend_dist, "index.html")
        if os.path.exists(index):
            return send_from_directory(frontend_dist, "index.html")
        return render_template("dashboard.html", node_name=cfg.name)

    @app.get("/assets/<path:filename>")
    def frontend_assets(filename):
        if os.path.isdir(frontend_dist):
            return send_from_directory(os.path.join(frontend_dist, "assets"), filename)
        return jsonify(error="Frontend build not found"), 404

    @app.get("/api/v1/status")
    def status():
        cpus = psutil.cpu_count(logical=True) or 1
        return jsonify({
            "node_id": discovery.node_id, "display_name": cfg.name,
            "cpu_percent": psutil.cpu_percent(interval=0.05),
            "logical_cpus": cpus,
            "free_memory_mb": round(psutil.virtual_memory().available / 1024 / 1024),
            "total_memory_mb": round(psutil.virtual_memory().total / 1024 / 1024),
            "capacity": capacity_for(cpus), "uptime_s": round(time.time() - started, 1),
            "success_rate": peer_manager.success_rate("local"), "in_flight": int(jobs.inflight.get("local", 0)),
            "free_memory_ratio": psutil.virtual_memory().available / max(1, psutil.virtual_memory().total),
            "cloud_fallback_enabled": jobs.cloud_fallback is not None,
            "execution_mode": jobs.get_execution_mode(),
            "protocol_version": cfg.protocol_version,
        })

    @app.post("/api/v1/execution-mode")
    def set_execution_mode():
        # The control is confined to the coordinator's own loopback dashboard.
        # Host and Origin checks also prevent a remote site from changing it via
        # a browser visiting a rebinding hostname.
        local_hosts = {"127.0.0.1:5000", "localhost:5000"}
        local_origins = {f"http://{host}" for host in local_hosts}
        local_origins.update({"http://127.0.0.1:5173", "http://localhost:5173"})
        if (request.remote_addr != "127.0.0.1" or request.host not in local_hosts
                or request.headers.get("Origin") not in local_origins):
            return jsonify(error="Mode changes require the local coordinator dashboard"), 403
        data = request.get_json(silent=True)
        if not isinstance(data, dict) or set(data) != {"execution_mode"} or data["execution_mode"] not in {"mesh", "cloud"}:
            return jsonify(error="execution_mode must be mesh or cloud"), 400
        try:
            jobs.set_execution_mode(data["execution_mode"])
        except RuntimeError as exc:
            return jsonify(error=str(exc)), 409
        return jsonify(execution_mode=jobs.get_execution_mode())

    @app.get("/api/v1/peers")
    def peers():
        return jsonify(peer_manager.snapshot())

    @app.post("/api/v1/mobile/workers/register")
    @require_token(cfg.token)
    def mobile_register():
        data = request.get_json(silent=True) or {}
        worker_id = peer_manager.mobile_workers.register(
            data.get("name", "Phone"), data.get("capacity", 1),
            data.get("cpu_percent", 0), data.get("free_memory_mb", 512),
            data.get("total_memory_mb", 1024), data.get("platform", "mobile"),
            data.get("client_id"),
        )
        return jsonify({"worker_id": worker_id, "protocol_version": "1.1"}), 201

    @app.get("/api/v1/mobile/workers/<worker_id>/tasks/next")
    @require_token(cfg.token)
    def mobile_next_task(worker_id):
        if not peer_manager.mobile_workers.heartbeat(
            worker_id, request.args.get("cpu_percent"), request.args.get("free_memory_mb"),
            request.args.get("total_memory_mb"), request.args.get("rtt_ms"),
        ):
            return jsonify(error="worker not registered"), 404
        task = peer_manager.mobile_workers.next_task(worker_id)
        return jsonify(task) if task else ("", 204)

    @app.delete("/api/v1/mobile/workers/<worker_id>")
    @require_token(cfg.token)
    def mobile_withdraw(worker_id):
        peer_manager.mobile_workers.withdraw(worker_id)
        return "", 204

    @app.post("/api/v1/mobile/workers/<worker_id>/heartbeat")
    @require_token(cfg.token)
    def mobile_heartbeat(worker_id):
        data = request.get_json(silent=True) or {}
        if not peer_manager.mobile_workers.heartbeat(
            worker_id, data.get("cpu_percent", 0), data.get("free_memory_mb"),
            data.get("total_memory_mb"), data.get("rtt_ms"),
        ):
            return jsonify(error="worker not registered"), 404
        return jsonify(status="online")

    @app.get("/api/v1/mobile/workers/<worker_id>/tasks/<task_id>/input")
    @require_token(cfg.token)
    def mobile_task_input(worker_id, task_id):
        data = peer_manager.mobile_workers.task_input(worker_id, task_id)
        return Response(data, mimetype="application/octet-stream") if data is not None else (jsonify(error="task not found"), 404)

    @app.post("/api/v1/mobile/workers/<worker_id>/tasks/<task_id>/result")
    @require_token(cfg.token)
    def mobile_task_result(worker_id, task_id):
        file = request.files.get("image")
        if not file:
            return jsonify(error="image missing"), 400
        try:
            output = file.read()
            with Image.open(BytesIO(output)) as image:
                image.load()
                if image.format not in {"JPEG", "PNG", "WEBP"}:
                    peer_manager.mobile_workers.fail(worker_id, task_id, "Phone worker returned unsupported image format")
                    return jsonify(error="unsupported worker image format"), 400
                result = {
                    "data": output, "size": list(image.size), "format": image.format,
                    "processing_ms": float(request.form.get("processing_ms", 0)),
                }
            if not peer_manager.mobile_workers.complete(worker_id, task_id, result):
                return jsonify(error="task is no longer active"), 409
            return jsonify(status="accepted")
        except Exception as exc:
            peer_manager.mobile_workers.fail(worker_id, task_id, str(exc))
            return jsonify(error="invalid worker image result"), 400

    @app.post("/api/v1/mobile/workers/<worker_id>/tasks/<task_id>/fail")
    @require_token(cfg.token)
    def mobile_task_fail(worker_id, task_id):
        data = request.get_json(silent=True) or {}
        if not peer_manager.mobile_workers.fail(worker_id, task_id, data.get("error", "Phone worker failed")):
            return jsonify(error="task is no longer active"), 404
        return jsonify(status="failure recorded"), 202

    @app.get("/api/v1/jobs")
    def recent_jobs():
        return jsonify(jobs=jobs.list_recent())

    @app.post("/api/v1/jobs")
    def create_job():
        files = request.files.getlist("images")
        if not files:
            return jsonify(error="No images uploaded"), 400
        if len(files) > cfg.max_images:
            return jsonify(error=f"Maximum {cfg.max_images} images"), 400
        total = 0
        for f in files:
            f.stream.seek(0, os.SEEK_END)
            total += f.stream.tell()
            f.stream.seek(0)
        if total > cfg.max_total_bytes:
            return jsonify(error="Maximum total upload size is 100 MB"), 413
        try:
            w = max(1, min(10000, int(request.form.get("max_width", 1280))))
            h = max(1, min(10000, int(request.form.get("max_height", 720))))
            job = jobs.create_job(files, w, h, request.form.get("submitted_from", "unknown"))
            return jsonify(job), 202
        except Exception as exc:
            return jsonify(error=str(exc)), 400

    @app.get("/api/v1/jobs/<job_id>")
    def job_status(job_id):
        job = jobs.get(job_id)
        return jsonify(job) if job else (jsonify(error="job not found"), 404)

    @app.get("/api/v1/jobs/<job_id>/download")
    def download(job_id):
        mem = jobs.make_zip(job_id)
        return send_file(mem, mimetype="application/zip", as_attachment=True,
                         download_name=f"{job_id}_results.zip") if mem else (jsonify(error="job not found"), 404)

    @app.post("/api/v1/tasks/resize")
    @require_token(cfg.token)
    def worker_resize():
        f = request.files.get("image")
        if not f:
            return jsonify(error="image missing"), 400
        try:
            data = f.read()
            w = max(1, min(10000, int(request.form.get("max_width", 1280))))
            h = max(1, min(10000, int(request.form.get("max_height", 720))))
            start = time.perf_counter()
            out, size, fmt, _ = resize_image(data, f.filename or "image.jpg", w, h)
            elapsed = round((time.perf_counter() - start) * 1000, 2)
            return Response(out, mimetype="application/octet-stream", headers={
                "X-Output-Width": str(size[0]), "X-Output-Height": str(size[1]),
                "X-Output-Format": fmt, "X-Processing-Ms": str(elapsed),
            })
        except Exception as exc:
            return jsonify(error=str(exc)), 400

    return app, discovery


def main():
    parser = argparse.ArgumentParser(description="Local-first ad hoc edge mesh with optional AWS fallback")
    parser.add_argument("--name", default="Laptop")
    parser.add_argument("--port", type=int, default=5000)
    parser.add_argument("--token", default="demo-token")
    parser.add_argument("--peer", action="append", default=[], help="Repeatable peer in IP:PORT form")
    args = parser.parse_args()
    try:
        cfg = Config(name=args.name, port=args.port, token=args.token)
        app, discovery = create_app(cfg)
    except ValueError as exc:
        parser.error(str(exc))
    for raw in args.peer:
        host, port = raw.rsplit(":", 1)
        discovery.add_manual(host, int(port))
    discovery.start()
    try:
        app.run(host=cfg.host, port=cfg.port, threaded=True, use_reloader=False)
    finally:
        discovery.stop()


if __name__ == "__main__":
    main()
