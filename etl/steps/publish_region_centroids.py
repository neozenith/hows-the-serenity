"""Publish per-region representative-point centroids as small JSON files.

Used by the frontend HexagonLayer to plot rental/sales medians as points
that bin into hexes. The HexagonLayer needs (lon, lat) per data point —
we can't extract those from the SAL MVT tiles client-side, so we publish
flat JSON lookups keyed by region code.

Output shape:
    {
      "<code>": [<lon>, <lat>],
      ...
    }

Codes are SAL_CODE21 for suburbs and LGA_CODE24 for LGAs. Coordinates are
EPSG:4326 (lon, lat) to match Deck.GL's default coordinate system.

`representative_point()` rather than `centroid()` so the result is
guaranteed to fall inside the polygon — important for non-convex shapes
(peninsular LGAs, C-shaped suburbs) where the centroid would fall in
water/outside.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

import geopandas as gpd

log = logging.getLogger("etl.steps.publish_region_centroids")


def _centroids_from_gdf(gdf: gpd.GeoDataFrame, code_col: str) -> dict[str, list[float]]:
    if gdf.crs is None:
        raise ValueError("Source GeoDataFrame has no CRS")
    # representative_point() is a planar operation — needs the geometry
    # already in EPSG:4326 for the output coords to be (lon, lat).
    if gdf.crs.to_epsg() != 4326:
        gdf = gdf.to_crs("EPSG:4326")
    if code_col not in gdf.columns:
        raise ValueError(
            f"Source GeoDataFrame missing {code_col!r}. Available: "
            f"{[c for c in gdf.columns if c != 'geometry']}"
        )
    # Drop null/empty geometries — the source SAL parquet ships with a
    # handful of rows for offshore-island or "no usual address" SALs
    # whose geometry is null. representative_point() returns None for
    # those, and skipping them keeps the JSON tight + valid.
    valid = gdf[gdf.geometry.notna() & ~gdf.geometry.is_empty]
    dropped = len(gdf) - len(valid)
    if dropped:
        log.info("Skipping %d rows with null/empty geometry", dropped)
    pts = valid.representative_point()
    return {
        str(code): [float(pt.x), float(pt.y)]
        for code, pt in zip(valid[code_col].tolist(), pts, strict=True)
    }


def run(
    *,
    sal_parquet: Path,
    lga_geojson: Path,
    suburb_output: Path,
    lga_output: Path,
) -> tuple[int, int]:
    """Emit suburb + LGA centroid lookups. Returns (suburb_count, lga_count)."""
    log.info("Reading SAL parquet <- %s", sal_parquet)
    sal_gdf = gpd.read_parquet(sal_parquet)
    suburb_centroids = _centroids_from_gdf(sal_gdf, "SAL_CODE21")
    log.info("Computed %d suburb centroids", len(suburb_centroids))

    log.info("Reading LGA GeoJSON <- %s", lga_geojson)
    lga_gdf = gpd.read_file(lga_geojson)
    lga_centroids = _centroids_from_gdf(lga_gdf, "LGA_CODE24")
    log.info("Computed %d LGA centroids", len(lga_centroids))

    suburb_output.parent.mkdir(parents=True, exist_ok=True)
    # `separators=(",", ":")` strips inter-field whitespace — for ~2400
    # suburb centroids this halves the file size on disk and over the wire.
    suburb_output.write_text(json.dumps(suburb_centroids, separators=(",", ":")), encoding="utf-8")
    log.info(
        "Wrote %s (%.1f KB, %d entries)",
        suburb_output,
        suburb_output.stat().st_size / 1024,
        len(suburb_centroids),
    )

    lga_output.parent.mkdir(parents=True, exist_ok=True)
    lga_output.write_text(json.dumps(lga_centroids, separators=(",", ":")), encoding="utf-8")
    log.info(
        "Wrote %s (%.1f KB, %d entries)",
        lga_output,
        lga_output.stat().st_size / 1024,
        len(lga_centroids),
    )

    return len(suburb_centroids), len(lga_centroids)
