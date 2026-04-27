"""Generic tile-encoding orchestration.

Reads a GeoParquet, reprojects to MVT's native CRS, iterates the XYZ tile
coordinates covering the bbox, and writes one .pbf per non-empty tile.

Layer-specific steps (`tile_sal`, `tile_isochrone`) just configure
`layer_name`, `keep_properties`, and zoom bounds — they don't reimplement
the loop.
"""

from __future__ import annotations

import logging
import shutil
from dataclasses import dataclass
from pathlib import Path

import geopandas as gpd

from etl.tiling.coords import tiles_covering_bbox
from etl.tiling.encode import encode_empty_tile, encode_tile
from etl.tiling.writer import write_tile

log = logging.getLogger("etl.steps.tile_layer")

# MVT's native projection — every tile's quantize_bounds and feature geometries
# must live in this CRS for Deck.GL MVTLayer to interpret them correctly.
MVT_CRS = "EPSG:3857"


@dataclass(frozen=True)
class TilingResult:
    tiles_written: int
    tiles_with_data: int
    empty_stubs: int
    total_bytes: int


def run(
    *,
    gdf: gpd.GeoDataFrame,
    output_dir: Path,
    layer_name: str,
    keep_properties: tuple[str, ...],
    min_zoom: int,
    max_zoom: int,
    layer_dir: str | None = None,
    clean: bool = True,
    write_empty_stubs: bool = True,
) -> TilingResult:
    """Tile `gdf` into MVT tiles at `output_dir/<layer_dir>/{z}/{x}/{y}.pbf`.

    `layer_dir` defaults to `layer_name` so URL templates and in-tile layer
    identifiers line up by default.

    If `write_empty_stubs=True`, every tile in [min_zoom, max_zoom] covering
    the source bbox is written — empty cells get an 18-byte stub MVT. This
    avoids 404s in the browser, which log to console regardless of how the
    consumer handles the failure. Set False for layers (e.g. SAL) where the
    source data covers the full bbox densely enough that stubs aren't needed.
    """
    layer_dir = layer_dir or layer_name

    log.info("Reprojecting to %s for MVT encoding", MVT_CRS)
    gdf_3857 = gdf.to_crs(MVT_CRS)

    bounds_4326 = gdf.to_crs("EPSG:4326").total_bounds  # [minx, miny, maxx, maxy]
    west, south, east, north = bounds_4326
    log.info(
        "Source bbox (EPSG:4326): W=%.4f S=%.4f E=%.4f N=%.4f",
        west,
        south,
        east,
        north,
    )

    target_root = output_dir / layer_dir
    if clean and target_root.exists():
        log.info("Cleaning prior tile output: %s", target_root)
        shutil.rmtree(target_root)

    empty_stub_bytes = encode_empty_tile(layer_name) if write_empty_stubs else b""
    with_data = 0
    stubs = 0
    total_bytes = 0
    for tile in tiles_covering_bbox(
        west=west, south=south, east=east, north=north, min_zoom=min_zoom, max_zoom=max_zoom
    ):
        mvt_bytes = encode_tile(
            gdf_3857=gdf_3857,
            tile=tile,
            layer_name=layer_name,
            keep_properties=keep_properties,
        )
        if mvt_bytes is None:
            if not write_empty_stubs:
                continue
            mvt_bytes = empty_stub_bytes
            stubs += 1
        else:
            with_data += 1
        path = write_tile(root=output_dir, layer_dir=layer_dir, tile=tile, mvt_bytes=mvt_bytes)
        total_bytes += path.stat().st_size
        written = with_data + stubs
        if written % 500 == 0:
            log.info(
                "Progress: z=%d wrote=%d (data=%d stubs=%d) total=%.1f MB",
                tile.z,
                written,
                with_data,
                stubs,
                total_bytes / 1_048_576,
            )

    written_total = with_data + stubs
    log.info(
        "Done: %d tiles written (data=%d, stubs=%d), %.1f MB total (%s)",
        written_total,
        with_data,
        stubs,
        total_bytes / 1_048_576,
        target_root,
    )
    return TilingResult(
        tiles_written=written_total,
        tiles_with_data=with_data,
        empty_stubs=stubs,
        total_bytes=total_bytes,
    )
