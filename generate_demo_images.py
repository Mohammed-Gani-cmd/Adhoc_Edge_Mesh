"""Generate a batch of synthetic high-resolution images for the classroom demo."""
from pathlib import Path
import argparse
from PIL import Image, ImageDraw


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--count", type=int, default=30)
    parser.add_argument("--output", default="demo_images")
    parser.add_argument("--width", type=int, default=2400)
    parser.add_argument("--height", type=int, default=1600)
    args = parser.parse_args()
    out = Path(args.output); out.mkdir(parents=True, exist_ok=True)
    for i in range(1, args.count + 1):
        im = Image.new("RGB", (args.width, args.height), (20 + i % 30, 70 + i % 50, 50 + i % 70))
        d = ImageDraw.Draw(im)
        d.text((80, 80), f"EDGE MESH DEMO  /  IMAGE {i:02d}", fill="white")
        d.rectangle((100, 220, args.width - 100, args.height - 150), outline="white", width=8)
        im.save(out / f"demo_{i:02d}.jpg", quality=92)
    print(f"Created {args.count} images in {out.resolve()}")


if __name__ == "__main__":
    main()
