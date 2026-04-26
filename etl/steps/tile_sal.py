"""Tile the SAL_2021 GeoParquet intermediate into MVT XYZ tiles."""

from __future__ import annotations

import logging
import shutil
from dataclasses import dataclass
from pathlib import Path

import geopandas as gpd

from etl.config import SAL_KEEP_PROPERTIES
from etl.tiling.coords import tiles_covering_bbox
from etl.tiling.encode import encode_tile
from etl.tiling.writer import write_tile

log = logging.getLogger("etl.steps.tile_sal")

# MVT's native projection — every tile's quantize_bounds and feature geometries
# must live in this CRS for Deck.GL MVTLayer to interpret them correctly.
MVT_CRS = "EPSG:3857"


@dataclass(frozen=True)
class TilingResult:
    tiles_written: int
    tiles_skipped_empty: int
    total_bytes: int


def run(
    *,
    input_parquet: Path,
    output_dir: Path,
    layer_name: str = "suburbs",
    layer_dir: str | None = None,
    min_zoom: int = 6,
    max_zoom: int = 11,
    clean: bool = True,
) -> TilingResult:
    """Tile `input_parquet` into MVT tiles under `output_dir/<layer_dir>/{z}/{x}/{y}.pbf`.

    `layer_dir` defaults to `layer_name` — the on-disk subdirectory matches the
    in-tile layer identifier so URL templates and MVT layer-name lookups align.
    """
    layer_dir = layer_dir or layer_name

    log.info("Reading GeoParquet <- %s", input_parquet)
    gdf = gpd.read_parquet(input_parquet)
    log.info("Loaded %d features (CRS: %s)", len(gdf), gdf.crs)

    log.info("Reprojecting to %s for MVT encoding", MVT_CRS)
    gdf_3857 = gdf.to_crs(MVT_CRS)

    # Compute WGS84 bbox for tile enumeration (mercantile takes lon/lat).
    bounds_4326 = gdf.to_crs("EPSG:4326").total_bounds  # [minx, miny, maxx, maxy]
    west, south, east, north = bounds_4326
    log.info("Source bbox (EPSG:4326): W=%.4f S=%.4f E=%.4f N=%.4f", west, south, east, north)

    target_root = output_dir / layer_dir
    if clean and target_root.exists():
        log.info("Cleaning prior tile output: %s", target_root)
        shutil.rmtree(target_root)

    written = 0
    skipped = 0
    total_bytes = 0
    for tile in tiles_covering_bbox(
        west=west, south=south, east=east, north=north, min_zoom=min_zoom, max_zoom=max_zoom
    ):
        mvt_bytes = encode_tile(
            gdf_3857=gdf_3857,
            tile=tile,
            layer_name=layer_name,
            keep_properties=SAL_KEEP_PROPERTIES,
        )
        if mvt_bytes is None:
            skipped += 1
            continue
        path = write_tile(root=output_dir, layer_dir=layer_dir, tile=tile, mvt_bytes=mvt_bytes)
        size = path.stat().st_size
        total_bytes += size
        written += 1
        if written % 100 == 0:
            log.info(
                "Progress: z=%d wrote=%d skipped=%d total=%.1f MB",
                tile.z,
                written,
                skipped,
                total_bytes / 1_048_576,
            )

    log.info(
        "Done: %d tiles written, %d empty tiles skipped, %.1f MB total (%s)",
        written,
        skipped,
        total_bytes / 1_048_576,
        target_root,
    )
    return TilingResult(tiles_written=written, tiles_skipped_empty=skipped, total_bytes=total_bytes)
