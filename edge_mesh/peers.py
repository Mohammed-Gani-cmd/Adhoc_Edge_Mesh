import time
import json
import os
import threading
import psutil
import requests
from .scheduler import capacity_for
from .mobile_workers import MobileWorkers


class PeerManager:
    def __init__(self, discovery, local_name="This laptop", local_port=5000, stats_path="edge_mesh_data/node_stats.json", inflight=None, protocol_version="1.1"):
        self.discovery = discovery
        self.local_name = local_name
        self.local_port = local_port
        self.protocol_version = protocol_version
        self.stats_path = stats_path
        self._stats_lock = threading.Lock()
        self.inflight = inflight or {}
        self.mobile_workers = MobileWorkers()
        try:
            with open(stats_path, encoding="utf-8") as stream:
                self._stats = json.load(stream)
        except (OSError, ValueError):
            self._stats = {}

    def record_result(self, node_id, success):
        with self._stats_lock:
            s = self._stats.setdefault(node_id, {"success": 0, "total": 0})
            s["total"] += 1
            if success:
                s["success"] += 1
            try:
                os.makedirs(os.path.dirname(self.stats_path) or ".", exist_ok=True)
                temp = self.stats_path + ".tmp"
                with open(temp, "w", encoding="utf-8") as stream:
                    json.dump(self._stats, stream)
                os.replace(temp, self.stats_path)
            except OSError:
                pass

    def success_rate(self, node_id):
        with self._stats_lock:
            s = self._stats.get(node_id)
        return 1.0 if not s or s["total"] == 0 else s["success"] / s["total"]

    def snapshot(self):
        cpus = psutil.cpu_count(logical=True) or 1
        peers = [{
            "node_id": "local",
            "name": self.local_name,
            "host": "127.0.0.1",
            "port": self.local_port,
            "online": True,
            "source": "local",
            "cpu_percent": psutil.cpu_percent(interval=0.05),
            "logical_cpus": cpus,
            "free_memory_mb": round(psutil.virtual_memory().available / 1024 / 1024),
            "capacity": capacity_for(cpus),
            "in_flight": int(self.inflight.get("local", 0)),
            "success_rate": self.success_rate("local"),
            "free_memory_ratio": psutil.virtual_memory().available / max(1, psutil.virtual_memory().total),
            "rtt_ms": 0.0,
            "protocol_version": self.protocol_version,
        }]
        for p in self.discovery.list_peers():
            item = dict(p)
            try:
                start = time.perf_counter()
                r = requests.get(
                    f"http://{p['host']}:{p['port']}/api/v1/status", timeout=2
                )
                item["rtt_ms"] = round((time.perf_counter() - start) * 1000, 1)
                if r.ok:
                    data = r.json()
                    item.update(data)
                    item["online"] = True
                    item["success_rate"] = self.success_rate(p["node_id"])
                    item["free_memory_ratio"] = min(1.0, float(data.get("free_memory_mb", 0)) / max(1, float(data.get("total_memory_mb", data.get("free_memory_mb", 1)))))
                else:
                    item["online"] = False
            except requests.RequestException as exc:
                item["online"] = False
                item["error"] = str(exc)
            peers.append(item)
        for mobile in self.mobile_workers.snapshot():
            mobile["success_rate"] = self.success_rate(mobile["node_id"])
            peers.append(mobile)
        return peers
