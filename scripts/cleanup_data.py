"""Remove completed local job folders older than the selected retention."""
import argparse
import os
import shutil
import time
from pathlib import Path


def cleanup(base_dir, retention_days, dry_run=False):
    root = Path(base_dir).resolve()
    if root.name != "edge_mesh_data":
        raise ValueError("Cleanup is restricted to an edge_mesh_data directory")
    cutoff = time.time() - retention_days * 86400
    removed = []
    if not root.exists():
        return removed
    for child in root.iterdir():
        if child.is_dir() and child.stat().st_mtime < cutoff:
            removed.append(child.name)
            if not dry_run:
                shutil.rmtree(child)
    return removed


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", default="edge_mesh_data")
    parser.add_argument("--retention-days", type=int, default=int(os.getenv("EDGE_DATA_RETENTION_DAYS", "7")))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    for name in cleanup(args.directory, args.retention_days, args.dry_run):
        print(("would remove " if args.dry_run else "removed ") + name)
