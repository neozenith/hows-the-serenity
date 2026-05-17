"""SAL agglomerative hierarchy tests (G7)."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import duckdb
import geopandas as gpd
from shapely.geometry import Polygon

from etl.steps import build_sal_hierarchy


def test_sal_hierarchy_cli_help() -> None:
    """T7.1 — `etl extract sal-hierarchy --help` exits 0 and surfaces the four
    required flags.

    Tracer bullet that proves the new `sal-hierarchy` leaf is wired through
    the `extract` parser group. Flag REGISTRATION only — the build body lands
    in T7.2.
    """
    result = subprocess.run(
        [sys.executable, "-m", "etl", "extract", "sal-hierarchy", "--help"],
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, (
        f"sal-hierarchy --help exited {result.returncode}\n"
        f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    )
    for flag in ("--input-sal-parquet", "--output-duckdb", "--ts-models-duckdb", "--cut-levels"):
        assert flag in result.stdout, (
            f"expected flag {flag!r} in --help output, got:\n{result.stdout}"
        )


def _make_grid_sal_parquet(path: Path) -> None:
    """Write a 5x5 grid of unit-square SAL polygons to `path` as a GeoParquet.

    Each cell is a 1x1 polygon at integer coordinates; SAL_CODE21 is the
    string '20001'..'20025'. CRS matches the production parquet (EPSG:7844).
    """
    rows: list[dict[str, object]] = []
    code = 20_001
    for row in range(5):
        for col in range(5):
            poly = Polygon(
                [
                    (col, row),
                    (col + 1, row),
                    (col + 1, row + 1),
                    (col, row + 1),
                ]
            )
            rows.append({"SAL_CODE21": str(code), "geometry": poly})
            code += 1
    gdf = gpd.GeoDataFrame(rows, crs="EPSG:7844")
    gdf.to_parquet(path)


def test_synthetic_grid_writes_expected_row_count(tmp_path: Path) -> None:
    """T7.2 — 25 SAL x 3 cut levels == 75 rows in geographic_hierarchy.

    Builds the hierarchy via adjacency-constrained agglomerative clustering,
    then asserts the row inventory + that every node_id is one of the 25
    synthetic SAL codes.
    """
    sal_parquet = tmp_path / "synthetic_sal.parquet"
    _make_grid_sal_parquet(sal_parquet)

    output_duckdb = tmp_path / "rental_sales.duckdb"
    ts_models = tmp_path / "ts_models.duckdb"
    expected_codes = {str(c) for c in range(20_001, 20_026)}

    build_sal_hierarchy.run(
        input_sal_parquet=sal_parquet,
        output_duckdb=output_duckdb,
        ts_models_duckdb=ts_models,
        cut_levels=(5, 10, 15),
    )

    con = duckdb.connect(str(output_duckdb), read_only=True)
    try:
        total = con.execute(
            "SELECT COUNT(*) FROM geographic_hierarchy WHERE tier = 'sal'"
        ).fetchone()
        node_codes = {
            row[0]
            for row in con.execute(
                "SELECT DISTINCT node_id FROM geographic_hierarchy WHERE tier = 'sal'"
            ).fetchall()
        }
        per_level = con.execute(
            "SELECT cluster_level, COUNT(*) "
            "FROM geographic_hierarchy WHERE tier = 'sal' "
            "GROUP BY cluster_level ORDER BY cluster_level"
        ).fetchall()
    finally:
        con.close()

    assert total is not None and total[0] == 75, (
        f"expected 25 SALs x 3 cut levels = 75 rows, got {total}"
    )
    assert node_codes == expected_codes, (
        f"unexpected node_ids: missing={expected_codes - node_codes}, "
        f"extras={node_codes - expected_codes}"
    )
    # Each cut level should have exactly 25 rows (one per SAL leaf).
    assert per_level == [(5, 25), (10, 25), (15, 25)], (
        f"expected 25 rows per cut level, got {per_level}"
    )


def test_clusters_are_contiguous(tmp_path: Path) -> None:
    """T7.3 — every (parent_cluster_id, cluster_level) group forms a single
    connected component under SAL `polygon.touches()` adjacency.

    Connectivity-by-construction property of T7.2's adjacency-constrained
    AgglomerativeClustering. This test guards against a future refactor that
    drops the `connectivity=adj` argument — without it, the algorithm could
    merge non-adjacent SALs into the same cluster.
    """
    from scipy.sparse.csgraph import connected_components

    sal_parquet = tmp_path / "synthetic_sal.parquet"
    _make_grid_sal_parquet(sal_parquet)

    output_duckdb = tmp_path / "rental_sales.duckdb"
    ts_models = tmp_path / "ts_models.duckdb"
    build_sal_hierarchy.run(
        input_sal_parquet=sal_parquet,
        output_duckdb=output_duckdb,
        ts_models_duckdb=ts_models,
        cut_levels=(5, 10, 15),
    )

    # Rebuild the same adjacency the build step constructed. Reproject to
    # EPSG:7855 to match the build step's CRS (touches() is geometry-only,
    # but reprojecting first guarantees we're checking the same graph the
    # algorithm saw).
    sal_gdf = gpd.read_parquet(sal_parquet).to_crs(epsg=7855)
    adj = build_sal_hierarchy._adjacency_matrix(sal_gdf.geometry)
    code_to_idx = {str(c): i for i, c in enumerate(sal_gdf["SAL_CODE21"])}

    con = duckdb.connect(str(output_duckdb), read_only=True)
    try:
        cluster_members = con.execute(
            "SELECT cluster_level, parent_cluster_id, node_id "
            "FROM geographic_hierarchy WHERE tier = 'sal'"
        ).fetchall()
    finally:
        con.close()

    # Group rows by (cluster_level, parent_cluster_id) → list of node indices.
    groups: dict[tuple[int, str], list[int]] = {}
    for level, parent, node_id in cluster_members:
        groups.setdefault((int(level), parent), []).append(code_to_idx[node_id])

    assert groups, "expected at least one cluster group; got none"

    for (level, parent), indices in groups.items():
        # Extract submatrix of `adj` over `indices`, then assert it has
        # exactly one connected component.
        sub = adj.tocsr()[indices, :][:, indices]
        n_components, _labels = connected_components(sub, directed=False)
        assert n_components == 1, (
            f"cluster ({level}, {parent}) with {len(indices)} members spans "
            f"{n_components} disconnected components — connectivity constraint broken"
        )


def _seed_rental_for_sals(con: duckdb.DuckDBPyConnection, sal_codes: list[str]) -> None:
    """Seed `rental_sales` with one minimal median rental row per SAL code.

    Used by T7.4 — n_nodes_with_rental counts leaf SALs whose SAL_CODE21
    appears in `rental_sales`. Other columns kept to production shape but
    populated with placeholder values.
    """
    from datetime import date

    import pandas as pd

    rows = [
        {
            "geospatial": f"suburb_{code}",
            "geospatial_codes": code,
            "geospatial_type": "suburb",
            "time_bucket": date(2023, 12, 1),
            "dwelling_type": "all",
            "bedrooms": "all",
            "dwelling_class": "all",
            "statistic": "median",
            "value": 500.0,
            "data_type": "rental",
            "data_frequency": "quarterly",
            "source_file": "synthetic",
            "source_sheet": "synthetic",
            "cell": "synthetic",
        }
        for code in sal_codes
    ]
    df = pd.DataFrame(rows)
    con.register("rs_src", df)
    con.execute("CREATE TABLE rental_sales AS SELECT * FROM rs_src")
    con.unregister("rs_src")


def test_n_nodes_with_rental_monotonic(tmp_path: Path) -> None:
    """T7.4 — walking UP the dendrogram (cluster_level descending in our
    convention, since cluster_level == cut count), n_nodes_with_rental
    is monotonically non-decreasing for every SAL chain.

    Spec wording says "ascending" which assumes cluster_level=0-at-leaf;
    our convention uses cluster_level = number of clusters at that cut, so
    walking up corresponds to cluster_level decreasing. The property is
    identical either way.

    Seeds rental data for HALF the synthetic SALs (codes 20001..20012);
    asserts: for each SAL, its chain across cluster_levels {15, 10, 5}
    sees its cluster's rental-leaf count grow (or hold) monotonically.
    """
    sal_parquet = tmp_path / "synthetic_sal.parquet"
    _make_grid_sal_parquet(sal_parquet)

    output_duckdb = tmp_path / "rental_sales.duckdb"
    rental_codes = [str(c) for c in range(20_001, 20_013)]  # 12 of 25 SALs
    con = duckdb.connect(str(output_duckdb))
    try:
        _seed_rental_for_sals(con, rental_codes)
    finally:
        con.close()

    ts_models = tmp_path / "ts_models.duckdb"
    build_sal_hierarchy.run(
        input_sal_parquet=sal_parquet,
        output_duckdb=output_duckdb,
        ts_models_duckdb=ts_models,
        cut_levels=(5, 10, 15),
    )

    # Pull each SAL's chain: (cluster_level, parent_cluster_id, n_nodes_with_rental).
    con = duckdb.connect(str(output_duckdb), read_only=True)
    try:
        rows = con.execute(
            """
            SELECT gh.node_id, gh.cluster_level, cc.n_nodes_with_rental
            FROM geographic_hierarchy gh
            INNER JOIN cluster_centroids cc
                ON gh.parent_cluster_id = cc.cluster_id
               AND gh.cluster_level = cc.cluster_level
               AND gh.tier = cc.tier
            WHERE gh.tier = 'sal'
            ORDER BY gh.node_id, gh.cluster_level DESC
            """
        ).fetchall()
    finally:
        con.close()

    assert rows, "expected non-empty join of geographic_hierarchy + cluster_centroids"

    chains: dict[str, list[tuple[int, int]]] = {}
    for node_id, level, n_rental in rows:
        chains.setdefault(node_id, []).append((int(level), int(n_rental)))

    from itertools import pairwise

    for node_id, chain in chains.items():
        # chain is already sorted by cluster_level DESC (walking UP the tree).
        # n_nodes_with_rental must be non-decreasing along that order.
        for prev, curr in pairwise(chain):
            assert curr[1] >= prev[1], (
                f"node {node_id}: n_nodes_with_rental decreased from {prev[1]} "
                f"at cluster_level={prev[0]} to {curr[1]} at cluster_level={curr[0]}"
            )


def test_linkage_matrix_row_count(tmp_path: Path) -> None:
    """T7.5 — full scipy-style linkage matrix has exactly N-1 rows for N leaves.

    Synthetic 5x5 grid → 25 leaves → 24 merge rows in
    `ts_models.linkage_matrix` with `tier='sal'`. Each row encodes one binary
    merge: (merge_step, cluster_a, cluster_b, distance, n_obs).
    """
    sal_parquet = tmp_path / "synthetic_sal.parquet"
    _make_grid_sal_parquet(sal_parquet)

    output_duckdb = tmp_path / "rental_sales.duckdb"
    ts_models = tmp_path / "ts_models.duckdb"
    build_sal_hierarchy.run(
        input_sal_parquet=sal_parquet,
        output_duckdb=output_duckdb,
        ts_models_duckdb=ts_models,
        cut_levels=(5, 10, 15),
    )

    con = duckdb.connect(str(ts_models), read_only=True)
    try:
        row_count = con.execute("SELECT COUNT(*) FROM linkage_matrix WHERE tier = 'sal'").fetchone()
        merge_steps = [
            row[0]
            for row in con.execute(
                "SELECT merge_step FROM linkage_matrix WHERE tier = 'sal' ORDER BY merge_step"
            ).fetchall()
        ]
        distinct_pairs = con.execute(
            "SELECT COUNT(*) FROM linkage_matrix WHERE tier = 'sal' AND cluster_a = cluster_b"
        ).fetchone()
    finally:
        con.close()

    assert row_count is not None
    assert distinct_pairs is not None
    row_count_value = row_count[0]
    distinct_pairs_value = distinct_pairs[0]

    assert row_count_value == 24, (
        f"expected 24 merge rows (N-1 for N=25 leaves), got {row_count_value}"
    )
    assert merge_steps == list(range(24)), (
        f"expected merge_step values {{0..23}}, got {merge_steps}"
    )
    assert distinct_pairs_value == 0, (
        f"every merge row must have distinct cluster_a/cluster_b; "
        f"{distinct_pairs_value} rows violated this"
    )
