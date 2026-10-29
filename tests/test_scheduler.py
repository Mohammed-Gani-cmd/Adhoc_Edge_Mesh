from edge_mesh.scheduler import capacity_for, choose_node, score


def test_capacity():
    assert capacity_for(8) == 4
    assert capacity_for(1) == 1
    assert capacity_for(16) == 4


def test_choose_node_prefers_available_capacity():
    peers = [
        {"node_id": "a", "online": True, "cpu_percent": 10, "rtt_ms": 5, "success_rate": 1, "logical_cpus": 4},
        {"node_id": "b", "online": True, "cpu_percent": 90, "rtt_ms": 50, "success_rate": 1, "logical_cpus": 4},
    ]
    assert choose_node(peers, {})["node_id"] == "a"
    assert choose_node(peers, {"a": 2})["node_id"] == "b"
    assert choose_node(peers, {"a": 2}, {"b"}) is None


def test_score_penalizes_inflight_work():
    base = {"cpu_percent": 20, "rtt_ms": 10, "success_rate": 1, "capacity": 4}
    assert score({**base, "in_flight": 0}) > score({**base, "in_flight": 4})
