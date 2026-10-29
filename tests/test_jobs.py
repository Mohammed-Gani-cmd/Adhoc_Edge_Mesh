import json
import zipfile
from io import BytesIO
from edge_mesh.scheduler import capacity_for


def test_capacity_bound():
    assert 1 <= capacity_for(2) <= 4


def test_manifest_json_shape():
    manifest = {"job_id": "abc", "items": [{"source_name": "x.jpg", "attempts": 1}]}
    assert json.loads(json.dumps(manifest))["items"][0]["source_name"] == "x.jpg"


def test_zip_can_contain_manifest():
    buf = BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("manifest.json", '{"items": []}')
    buf.seek(0)
    with zipfile.ZipFile(buf) as z:
        assert "manifest.json" in z.namelist()
