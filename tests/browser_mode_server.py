"""Loopback coordinator with a fake cloud worker for browser mode checks."""
from pathlib import Path
import os
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from flask import render_template
from edge_mesh.app import create_app
from edge_mesh.config import Config


with tempfile.TemporaryDirectory(prefix="edge-mesh-browser-mode-") as folder:
    os.chdir(folder)
    app, _ = create_app(Config(port=5000, cloud_enabled=False))
    app.config["EDGE_JOBS"].cloud_fallback = object()

    @app.get("/legacy")
    def legacy():
        return render_template("dashboard.html")

    app.run(host="127.0.0.1", port=5000, threaded=True, use_reloader=False)
