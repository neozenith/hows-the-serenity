"""LGA agglomerative hierarchy tests (G8)."""

from __future__ import annotations

from pathlib import Path

import duckdb
import geopandas as gpd
from shapely.geometry import Polygon

from etl.steps import build_lga_hierarchy, build_sal_hierarchy
from etl.tests.test_build_sal_hierarchy import _make_grid_sal_parquet


def _make_grid_lga_parquet(path: Path, side: int = 3) -> None:
    """Write a `side`x`side` grid of unit-square LGA polygons to `path`.

    LGA_CODE24 is the string '10001'..'1000N'. CRS matches the production
    parquet (EPSG:7844).
    """
    rows: list[dict[str, object]] = []
    code = 10_001
    for row in range(side):
        for col in range(side):
            poly = Polygon(
                [
                    (col, row),
                    (col + 1, row),
                    (col + 1, row + 1),
                    (col, row + 1),
                ]
            )
            rows.append({"LGA_CODE24": str(code), "geometry": poly})
            code += 1
    gdf = gpd.GeoDataFrame(rows, crs="EPSG:7844")
    gdf.to_parquet(path)


def test_lga_hierarchy_writes_tier_lga_rows(tmp_path: Path) -> None:
    """T8.1 — 9 LGAs x 2 cut levels == 18 rows in geographic_hierarchy.

    Asserts:
    - geographic_hierarchy: 18 rows with tier='lga'
    - cluster_centroids: matching cluster summary rows with tier='lga'
    - ts_models.linkage_matrix: 8 merge rows (N-1 for N=9 leaves) with tier='lga'
    """
    lga_parquet = tmp_path / "synthetic_lga.parquet"
    _make_grid_lga_parquet(lga_parquet, side=3)

    output_duckdb = tmp_path / "rental_sales.duckdb"
    ts_models = tmp_path / "ts_models.duckdb"
    expected_codes = {str(c) for c in range(10_001, 10_010)}

    build_lga_hierarchy.run(
        input_lga_parquet=lga_parquet,
        output_duckdb=output_duckdb,
        ts_models_duckdb=ts_models,
        cut_levels=(3, 5),
    )

    con = duckdb.connect(str(output_duckdb), read_only=True)
    try:
        hier_count = con.execute(
            "SELECT COUNT(*) FROM geographic_hierarchy WHERE tier = 'lga'"
        ).fetchone()
        node_codes = {
            row[0]
            for row in con.execute(
                "SELECT DISTINCT node_id FROM geographic_hierarchy WHERE tier = 'lga'"
            ).fetchall()
        }
        cluster_count = con.execute(
            "SELECT COUNT(*) FROM cluster_centroids WHERE tier = 'lga'"
        ).fetchone()
    finally:
        con.close()

    assert hier_count is not None
    assert hier_count[0] == 18, f"expected 9 LGAs x 2 cut levels = 18 rows, got {hier_count[0]}"
    assert node_codes == expected_codes

    ts_con = duckdb.connect(str(ts_models), read_only=True)
    try:
        linkage_count = ts_con.execute(
            "SELECT COUNT(*) FROM linkage_matrix WHERE tier = 'lga'"
        ).fetchone()
    finally:
        ts_con.close()

    assert linkage_count is not None
    assert linkage_count[0] == 8, f"expected N-1=8 linkage rows for 9 LGAs, got {linkage_count[0]}"
    # cut_levels=(3, 5) → 3 + 5 = 8 cluster rows.
    assert cluster_count is not None
    assert cluster_count[0] == 8, f"expected 3+5=8 cluster_centroids rows, got {cluster_count[0]}"


def test_no_tier_cross_contamination(tmp_path: Path) -> None:
    """T8.2 — fused tables hold only tier ∈ {'sal','lga'} and no node_id
    appears with both tiers.

    Runs both SAL + LGA builds against the same output DuckDB. SAL codes
    (20001..) and LGA codes (10001..) live in disjoint ranges, so any
    cross-contamination would surface as a node_id appearing on both
    `tier='sal'` AND `tier='lga'` rows.
    """
    sal_parquet = tmp_path / "synthetic_sal.parquet"
    lga_parquet = tmp_path / "synthetic_lga.parquet"
    _make_grid_sal_parquet(sal_parquet)
    _make_grid_lga_parquet(lga_parquet, side=3)

    output_duckdb = tmp_path / "rental_sales.duckdb"
    ts_models = tmp_path / "ts_models.duckdb"

    build_sal_hierarchy.run(
        input_sal_parquet=sal_parquet,
        output_duckdb=output_duckdb,
        ts_models_duckdb=ts_models,
        cut_levels=(5, 10, 15),
    )
    build_lga_hierarchy.run(
        input_lga_parquet=lga_parquet,
        output_duckdb=output_duckdb,
        ts_models_duckdb=ts_models,
        cut_levels=(3, 5),
    )

    con = duckdb.connect(str(output_duckdb), read_only=True)
    try:
        unknown_tier = con.execute(
            "SELECT COUNT(*) FROM geographic_hierarchy WHERE tier NOT IN ('sal', 'lga')"
        ).fetchone()
        cross_tier_nodes = con.execute(
            """
            SELECT COUNT(*) FROM (
                SELECT node_id
                FROM geographic_hierarchy
                GROUP BY node_id
                HAVING COUNT(DISTINCT tier) > 1
            )
            """
        ).fetchone()
        unknown_centroid_tier = con.execute(
            "SELECT COUNT(*) FROM cluster_centroids WHERE tier NOT IN ('sal', 'lga')"
        ).fetchone()
    finally:
        con.close()

    ts_con = duckdb.connect(str(ts_models), read_only=True)
    try:
        unknown_linkage_tier = ts_con.execute(
            "SELECT COUNT(*) FROM linkage_matrix WHERE tier NOT IN ('sal', 'lga')"
        ).fetchone()
    finally:
        ts_con.close()

    assert unknown_tier is not None
    assert cross_tier_nodes is not None
    assert unknown_centroid_tier is not None
    assert unknown_linkage_tier is not None
    assert unknown_tier[0] == 0, (
        f"geographic_hierarchy has {unknown_tier[0]} rows with tier outside {{'sal','lga'}}"
    )
    assert cross_tier_nodes[0] == 0, f"{cross_tier_nodes[0]} node_id values appear under both tiers"
    assert unknown_centroid_tier[0] == 0
    assert unknown_linkage_tier[0] == 0
