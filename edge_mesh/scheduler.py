"""Small, deterministic scheduler used by the demo coordinator."""


def capacity_for(logical_cpu_count):
    return min(4, max(1, (logical_cpu_count or 1) // 2))


def score(peer):
    """Score CPU (40%), memory (15%), RTT (25%), reliability (20%)."""
    cpu = max(0.0, min(100.0, float(peer.get("cpu_percent", 100))))
    available_cpu = 1.0 - cpu / 100.0
    free_memory = max(0.0, min(1.0, float(peer.get("free_memory_ratio", 0.5))))
    latency = max(0.0, float(peer.get("rtt_ms", 1000) or 1000))
    inverse_latency = 1.0 / (1.0 + latency / 100.0)
    reliability = max(0.0, min(1.0, float(peer.get("success_rate", 1.0) or 0.0)))
    inflight = max(0, int(peer.get("in_flight", 0) or 0))
    capacity = max(1, int(peer.get("capacity", 1) or 1))
    penalty = min(0.5, (inflight / capacity) * 0.5)
    return max(0.0, available_cpu * 0.4 + free_memory * 0.15 + inverse_latency * 0.25 + reliability * 0.2 - penalty)


def choose_node(peers, used=None, excluded=None):
    used = used or {}
    excluded = excluded or set()
    candidates = []
    for raw in peers:
        p = dict(raw)
        node_id = p.get("node_id")
        if node_id in excluded or not p.get("online", False):
            continue
        capacity = int(p.get("capacity") or capacity_for(p.get("logical_cpus", 1)))
        p["capacity"] = capacity
        p["in_flight"] = int(used.get(node_id, p.get("in_flight", 0)) or 0)
        if p["in_flight"] < capacity:
            p["score"] = score(p)
            candidates.append(p)
    return max(candidates, key=lambda x: x["score"], default=None)
