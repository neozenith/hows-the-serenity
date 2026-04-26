"""Write encoded MVT bytes to the {z}/{x}/{y}.pbf directory tree."""

from __future__ import annotations

from pathlib import Path

from etl.tiling.coords import TileBounds


def tile_path(*, root: Path, layer_dir: str, tile: TileBounds) -> Path:
    """Return the on-disk path for `tile` under `root/layer_dir/{z}/{x}/{y}.pbf`."""
    return root / layer_dir / str(tile.z) / str(tile.x) / f"{tile.y}.pbf"


def write_tile(*, root: Path, layer_dir: str, tile: TileBounds, mvt_bytes: bytes) -> Path:
    """Write raw MVT protobuf bytes to the canonical XYZ path. Returns the path.

    Tiles are NOT file-level gzipped: loaders.gl's MVT parser does not
    auto-detect gzip wrappers, and GitHub Pages does not apply
    Content-Encoding: gzip to application/octet-stream responses, so a
    gzipped file would parse as garbage in the browser. Git's pack files
    compress these protobufs transparently in the repo, so the on-disk
    size you see locally is not the size that ships in clones.
    """
    out_path = tile_path(root=root, layer_dir=layer_dir, tile=tile)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(mvt_bytes)
    return out_path
