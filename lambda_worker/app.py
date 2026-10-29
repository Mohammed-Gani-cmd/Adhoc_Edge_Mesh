import json
import os
import time
from io import BytesIO

import boto3
from PIL import Image, ImageOps

s3 = boto3.client("s3")


def handler(event, context):
    bucket = event["bucket"]
    input_key = event["input_key"]
    output_key = event["output_key"]
    if not input_key.startswith("edge-mesh/tasks/") or not output_key.startswith("edge-mesh/tasks/"):
        return {"statusCode": 400, "error": "Invalid object key"}
    if bucket != os.environ.get("EDGE_STAGING_BUCKET", bucket):
        return {"statusCode": 400, "error": "Unexpected staging bucket"}
    started = time.perf_counter()
    try:
        raw = s3.get_object(Bucket=bucket, Key=input_key)["Body"].read()
        with Image.open(BytesIO(raw)) as source:
            fmt = source.format
            if fmt not in {"JPEG", "PNG", "WEBP"}:
                return {"statusCode": 400, "error": "Unsupported image format"}
            image = ImageOps.exif_transpose(source)
            image.thumbnail((int(event["max_width"]), int(event["max_height"])), Image.Resampling.LANCZOS)
            output = BytesIO()
            if fmt == "JPEG" and image.mode not in ("RGB", "L"):
                background = Image.new("RGB", image.size, "white")
                if "A" in image.getbands():
                    background.paste(image, mask=image.getchannel("A"))
                else:
                    background.paste(image)
                image = background
            options = {"quality": 90} if fmt in {"JPEG", "WEBP"} else {}
            image.save(output, format=fmt, **options)
            size = list(image.size)
        s3.put_object(Bucket=bucket, Key=output_key, Body=output.getvalue())
        return {"statusCode": 200, "size": size, "format": fmt,
                "processing_ms": round((time.perf_counter() - started) * 1000, 2)}
    except Exception as exc:
        return {"statusCode": 400, "error": str(exc)}
