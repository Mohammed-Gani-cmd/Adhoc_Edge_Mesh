from io import BytesIO
from PIL import Image, ImageOps

ALLOWED_FORMATS = {"JPEG": "JPEG", "PNG": "PNG", "WEBP": "WEBP"}
ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}


def validate_image(data: bytes, filename: str):
    if not data:
        raise ValueError("Image is empty")
    ext = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext not in ALLOWED_EXTENSIONS:
        raise ValueError("Only JPEG, PNG, and WebP images are supported")
    try:
        with Image.open(BytesIO(data)) as im:
            if im.format not in ALLOWED_FORMATS:
                raise ValueError("Unsupported image format")
            im.verify()
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError("Invalid or corrupted image") from exc


def resize_image(data: bytes, filename: str, max_width: int, max_height: int):
    validate_image(data, filename)
    with Image.open(BytesIO(data)) as opened:
        original_size = opened.size
        fmt = opened.format
        im = ImageOps.exif_transpose(opened)
        im.thumbnail((max_width, max_height), Image.Resampling.LANCZOS)
        out = BytesIO()
        save_fmt = ALLOWED_FORMATS[fmt]
        save_kwargs = {}
        if save_fmt == "JPEG":
            if im.mode not in ("RGB", "L"):
                bg = Image.new("RGB", im.size, "white")
                if "A" in im.getbands():
                    bg.paste(im, mask=im.getchannel("A"))
                else:
                    bg.paste(im)
                im = bg
            save_kwargs.update(quality=90, optimize=True)
        elif save_fmt == "WEBP":
            save_kwargs.update(quality=90, method=4)
        im.save(out, format=save_fmt, **save_kwargs)
        return out.getvalue(), im.size, save_fmt, original_size
