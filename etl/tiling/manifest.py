"""Per-layer tile manifest writer.

Each tile tree gets a `manifest.json` at its root listing the exact (z,x,y)
tile coordinates that have data. The frontend uses this to gate fetches:
coords not in the manifest are skipped without a network request, so 404s
disappear except where they signal a genuine bug (an in-manifest tile that
failed to land on disk).

Manifest schema (stable — frontend depends on these field names):

    {
      "name": "<layer name in MVT, e.g. 'suburbs'>",
      "format": "pbf",
      "minZoom": <int>,
      "maxZoom": <int>,
      "bounds": [west, south, east, north],   // EPSG:4326 degrees
      "tiles": ["<z>/<x>/<y>", ...]           // one entry per tile with data
    }
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterable
from pathlib import Path

from etl.tiling.coords import TileBounds

log = logging.getLogger("etl.tiling.manifest")

MANIFEST_FILENAME = "manifest.json"


def write_manifest(
    *,
    output_dir: Path,
    layer_dir: str,
    layer_name: str,
    bounds_4326: tuple[float, float, float, float],
    min_zoom: int,
    max_zoom: int,
    tile_coords: Iterable[TileBounds],
) -> Path:
    """Write `manifest.json` describing the tile-tree coverage."""
    coord_strs = sorted(f"{t.z}/{t.x}/{t.y}" for t in tile_coords)
    payload = {
        "name": layer_name,
        "format": "pbf",
        "minZoom": min_zoom,
        "maxZoom": max_zoom,
        "bounds": list(bounds_4326),
        "tiles": coord_strs,
    }
    path = output_dir / layer_dir / MANIFEST_FILENAME
    path.parent.mkdir(parents=True, exist_ok=True)
    # Compact JSON — manifest is consumed by the browser, not edited by humans.
    path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    log.info(
        "Wrote manifest with %d tile coords -> %s (%.1f KB)",
        len(coord_strs),
        path,
        path.stat().st_size / 1024,
    )
    return path
