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

from etl.tiling.coords import TileBounds, tiles_covering_bbox
from etl.tiling.encode import encode_tile
from etl.tiling.manifest import write_manifest
from etl.tiling.writer import write_tile

log = logging.getLogger("etl.steps.tile_layer")

# MVT's native projection — every tile's quantize_bounds and feature geometries
# must live in this CRS for Deck.GL MVTLayer to interpret them correctly.
MVT_CRS = "EPSG:3857"


@dataclass(frozen=True)
class TilingResult:
    tiles_written: int
    total_bytes: int
    manifest_path: Path


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
) -> TilingResult:
    """Tile `gdf` into MVT tiles at `output_dir/<layer_dir>/{z}/{x}/{y}.pbf`.

    Only tiles whose bbox intersects source features are written; a per-layer
    `manifest.json` is emitted alongside listing exactly which (z,x,y) coords
    exist. The frontend gates fetches against that manifest, so empty cells
    are skipped without producing 404s.
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

    written_coords: list[TileBounds] = []
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
            continue
        path = write_tile(root=output_dir, layer_dir=layer_dir, tile=tile, mvt_bytes=mvt_bytes)
        total_bytes += path.stat().st_size
        written_coords.append(tile)
        if len(written_coords) % 500 == 0:
            log.info(
                "Progress: z=%d wrote=%d total=%.1f MB",
                tile.z,
                len(written_coords),
                total_bytes / 1_048_576,
            )

    log.info(
        "Done: %d tiles written, %.1f MB total (%s)",
        len(written_coords),
        total_bytes / 1_048_576,
        target_root,
    )
    manifest_path = write_manifest(
        output_dir=output_dir,
        layer_dir=layer_dir,
        layer_name=layer_name,
        bounds_4326=(west, south, east, north),
        min_zoom=min_zoom,
        max_zoom=max_zoom,
        tile_coords=written_coords,
    )
    return TilingResult(
        tiles_written=len(written_coords),
        total_bytes=total_bytes,
        manifest_path=manifest_path,
    )
