"""Foreground phone workers that poll the laptop coordinator over LAN HTTP."""
import threading
import time
import uuid
import re
from concurrent.futures import Future


class MobileWorkers:
    def __init__(self):
        self.lock = threading.RLock()
        self.workers = {}
        self.tasks = {}

    def register(self, name, capacity=1, cpu_percent=0, free_memory_mb=512, total_memory_mb=1024, platform="mobile", client_id=None):
        stable_id = re.sub(r"[^a-fA-F0-9]", "", str(client_id or ""))
        worker_id = "mobile-" + (stable_id[:24].lower() if len(stable_id) >= 24 else uuid.uuid4().hex[:12])
        with self.lock:
            self.withdraw(worker_id)
            self.workers[worker_id] = {
                "node_id": worker_id, "name": name or "Phone", "online": True,
                "source": "mobile", "capacity": max(1, min(2, int(capacity))),
                "in_flight": 0, "cpu_percent": max(0, min(100, float(cpu_percent))),
                "free_memory_mb": max(64, int(free_memory_mb)),
                "total_memory_mb": max(128, int(total_memory_mb)), "rtt_ms": 5,
                "platform": platform,
                "success_rate": 1.0, "last_seen": time.time(), "pending": [],
            }
        return worker_id

    def withdraw(self, worker_id):
        """Stop allocating work and release assigned tasks for scheduler retry."""
        with self.lock:
            self.workers.pop(worker_id, None)
            for task in self.tasks.values():
                if task["worker_id"] == worker_id and not task["future"].done():
                    task["future"].set_exception(RuntimeError("Phone worker left the mesh"))

    def heartbeat(self, worker_id, cpu_percent=None, free_memory_mb=None, total_memory_mb=None, rtt_ms=None):
        with self.lock:
            worker = self.workers.get(worker_id)
            if not worker:
                return False
            worker["last_seen"] = time.time()
            worker["online"] = True
            if cpu_percent is not None:
                worker["cpu_percent"] = max(0, min(100, float(cpu_percent)))
            if free_memory_mb is not None:
                worker["free_memory_mb"] = max(64, int(free_memory_mb))
            if total_memory_mb is not None:
                worker["total_memory_mb"] = max(128, int(total_memory_mb))
            if rtt_ms is not None:
                worker["rtt_ms"] = max(0, float(rtt_ms))
            return True

    def snapshot(self):
        now = time.time()
        with self.lock:
            result = []
            for worker in self.workers.values():
                worker["online"] = now - worker["last_seen"] < 15
                worker["free_memory_ratio"] = min(1.0, worker["free_memory_mb"] / max(1, worker["total_memory_mb"]))
                result.append({k: v for k, v in worker.items() if k != "pending"})
            return result

    def execute(self, worker_id, task):
        future = Future()
        task_id = uuid.uuid4().hex
        with self.lock:
            worker = self.workers.get(worker_id)
            if not worker or time.time() - worker["last_seen"] >= 15:
                raise RuntimeError("Phone worker is offline")
            worker["pending"].append({"task_id": task_id, **{k: v for k, v in task.items() if k != "data"}})
            worker["in_flight"] += 1
            self.tasks[task_id] = {
                "future": future, "worker_id": worker_id, "data": task["data"],
                "max_width": task["max_width"], "max_height": task["max_height"],
            }
        try:
            return future.result(timeout=60)
        finally:
            with self.lock:
                # Keep the original registration: the same phone may have rejoined.
                worker["in_flight"] = max(0, worker["in_flight"] - 1)
                worker["pending"] = [task for task in worker["pending"] if task["task_id"] != task_id]
                self.tasks.pop(task_id, None)

    def next_task(self, worker_id):
        with self.lock:
            worker = self.workers.get(worker_id)
            if not worker or time.time() - worker["last_seen"] >= 15:
                return None
            worker["last_seen"] = time.time()
            return worker["pending"].pop(0) if worker["pending"] else None

    def complete(self, worker_id, task_id, result):
        with self.lock:
            task = self.tasks.get(task_id)
            if not task or task["worker_id"] != worker_id or task["future"].done():
                return False
            if result["format"] not in {"JPEG", "PNG", "WEBP"} or not 0 < result["size"][0] <= task["max_width"] or not 0 < result["size"][1] <= task["max_height"]:
                task["future"].set_exception(RuntimeError("Phone worker returned an unsupported or oversized image"))
                return False
            self.workers[worker_id]["last_seen"] = time.time()
            task["future"].set_result(result)
            return True

    def task_input(self, worker_id, task_id):
        with self.lock:
            task = self.tasks.get(task_id)
            if not task or task["worker_id"] != worker_id or task["future"].done():
                return None
            return task["data"]

    def fail(self, worker_id, task_id, error):
        with self.lock:
            task = self.tasks.get(task_id)
            if not task or task["worker_id"] != worker_id or task["future"].done():
                return False
            task["future"].set_exception(RuntimeError(error))
            self.workers[worker_id]["last_seen"] = time.time()
            return True
