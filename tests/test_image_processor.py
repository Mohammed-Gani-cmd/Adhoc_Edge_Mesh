from io import BytesIO
from PIL import Image
import pytest
from edge_mesh.image_processor import resize_image, validate_image


def make_image(fmt="JPEG", size=(4000, 2000), mode="RGB"):
    im = Image.new(mode, size, "white")
    b = BytesIO(); im.save(b, format=fmt); return b.getvalue()


def test_resize_no_upscale():
    out, size, fmt, original = resize_image(make_image(), "x.jpg", 1280, 720)
    assert size == (1280, 640)
    assert fmt == "JPEG"
    assert original == (4000, 2000)
    assert len(out) > 0


def test_small_image_is_not_upscaled():
    _, size, _, _ = resize_image(make_image(size=(300, 200)), "x.jpg", 1280, 720)
    assert size == (300, 200)


def test_formats_are_preserved():
    for fmt, ext in [("PNG", "x.png"), ("WEBP", "x.webp")]:
        _, _, output_fmt, _ = resize_image(make_image(fmt), ext, 100, 100)
        assert output_fmt == fmt


def test_invalid_extension():
    with pytest.raises(ValueError):
        validate_image(make_image(), "x.gif")


def test_corrupt_image():
    with pytest.raises(ValueError):
        validate_image(b"not-an-image", "x.jpg")
