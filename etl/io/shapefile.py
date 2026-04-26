"""Read ESRI shapefiles directly from a zip archive into a GeoDataFrame."""

from __future__ import annotations

import logging
from pathlib import Path

import geopandas as gpd

log = logging.getLogger("etl.io.shapefile")


def read_zipped_shapefile(zip_path: Path) -> gpd.GeoDataFrame:
    """Load a shapefile from a zip without extracting to disk.

    pyogrio (geopandas' default IO backend) supports the GDAL `/vsizip/`
    virtual file system, so we just point it at zip://path/to.zip and
    GDAL handles the rest. No need to manage tmp dirs.
    """
    if not zip_path.exists():
        raise FileNotFoundError(f"Shapefile zip not found: {zip_path}")

    uri = f"zip://{zip_path}"
    log.info("Reading shapefile via vsizip: %s", uri)
    gdf = gpd.read_file(uri)
    log.info("Loaded %d features (CRS: %s)", len(gdf), gdf.crs)
    return gdf
