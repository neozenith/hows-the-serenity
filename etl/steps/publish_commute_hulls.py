"""Publish PTV commute-tier hull GeoJSON to public/data/.

The upstream files (`ptv_commute_tier_hulls_metro_{train,tram}.geojson`) are
4 polygons each totalling ~3 KB — well below the threshold where MVT tiling
would help. Just prune to the properties the frontend renders and copy to
public/data/ as static GeoJSON; loaded directly via Deck.GL's GeoJsonLayer.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable
from pathlib import Path

import geopandas as gpd

log = logging.getLogger("etl.steps.publish_commute_hulls")


def _write(gdf: gpd.GeoDataFrame, output_geojson: Path) -> None:
    output_geojson.parent.mkdir(parents=True, exist_ok=True)
    # Driver=GeoJSON, EPSG:4326 — same defaults as the rest of the pipeline.
    gdf.to_file(output_geojson, driver="GeoJSON", engine="pyogrio")
    log.info(
        "Wrote %s — %.1f KB (%d features)",
        output_geojson.name,
        output_geojson.stat().st_size / 1024,
        len(gdf),
    )


def run(
    *,
    input_geojson: Path,
    output_geojson: Path,
    keep_properties: Iterable[str],
    split_by_centre: bool = False,
) -> int:
    """Prune hull properties and publish to public/data.

    With ``split_by_centre``, also emits one file per centre alongside the
    combined layer (``commute_hulls_<mode>__<centre>.geojson``). The split
    files exist so each centre can be toggled independently while we review
    hull geometry; the combined file stays authoritative for the merged
    layer we return to once the shapes are settled.
    """
    if not input_geojson.exists():
        raise FileNotFoundError(f"Commute-hulls source not found: {input_geojson}")

    log.info("Reading %s", input_geojson)
    gdf = gpd.read_file(input_geojson)
    log.info("Loaded %d features (CRS: %s)", len(gdf), gdf.crs)

    keep = list(keep_properties)
    missing = [p for p in keep if p not in gdf.columns]
    if missing:
        raise ValueError(
            f"Requested properties not present on input: {missing}. "
            f"Available: {[c for c in gdf.columns if c != 'geometry']}"
        )

    pruned = gdf[[*keep, "geometry"]].copy()
    _write(pruned, output_geojson)

    if split_by_centre:
        if "centre" not in pruned.columns:
            raise ValueError(
                "split_by_centre requires a 'centre' property; "
                f"available: {[c for c in pruned.columns if c != 'geometry']}"
            )
        stem = output_geojson.stem
        for slug in sorted(pruned["centre"].unique()):
            _write(
                pruned[pruned["centre"] == slug].copy(),
                output_geojson.with_name(f"{stem}__{slug}.geojson"),
            )

    return len(pruned)
