"""Publish a single dataset-version pointer for frontend cache-busting.

Writes `public/data/version.json` containing:

    {
      "version": <int unix epoch when this step ran>,
      "generated_at": "<ISO 8601 UTC timestamp>"
    }

The frontend loads this file with `cache: "no-cache"` at startup and
appends `?v=<version>` to every non-tile artefact fetch (DuckDB file,
H3 cell JSONs, names JSONs, commute hulls GeoJSON, LGA GeoJSON, etc.).
That gives a single source of truth for "is the cached data fresh?".

Tile content uses a separate per-layer cache-bust mechanism (each tile
tree's manifest.json carries its own `version` int). The two schemes are
orthogonal:
- Per-layer (tiles): cheap re-tiling of one layer doesn't invalidate
  CDN caches for unchanged layers.
- Global (this file): single coarse pointer for every non-tile artefact;
  one ETL run = one version cliff for the data layer.

This step is intentionally the LAST step in the `etl all` pipeline. If
version.json updated before downstream artefacts, a user hitting the
site mid-deploy could see a fresh pointer with `?v=<new>` while the
underlying JSON files still serve old bytes. Last-write semantics:
once version.json updates, every other artefact is known to be fresh.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import time
from pathlib import Path

log = logging.getLogger("etl.steps.publish_version")


def run(*, output: Path) -> int:
    """Write version.json. Returns the version int that was written."""
    now = int(time.time())
    payload = {
        "version": now,
        # ISO 8601 in UTC — humans reading the file shouldn't have to
        # decode the epoch. The frontend only reads `version`.
        "generated_at": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    log.info("Wrote %s (version=%d, %d bytes)", output, now, output.stat().st_size)
    return now
