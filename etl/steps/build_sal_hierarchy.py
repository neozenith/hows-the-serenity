"""SAL geographic agglomerative hierarchy builder (G7).

Builds an adjacency-constrained agglomerative clustering over SAL polygons:
- Reprojects to MGA Zone 55 (EPSG:7855) so centroids are in metres.
- Builds the adjacency graph via `polygon.touches()`.
- Runs sklearn's `AgglomerativeClustering(linkage='average', connectivity=adj)`
  for each requested cut level — the `connectivity` argument is what makes
  clusters spatially contiguous (T7.3 contracts on this).
- Writes one row per (SAL, cut_level) into `geographic_hierarchy` with
  `tier='sal'`. Scipy linkage matrix persistence is T7.5 work; per-cluster
  centroids + n_nodes_with_rental are T7.4 work.
"""

from __future__ import annotations

import logging
from pathlib import Path

import duckdb
import geopandas as gpd
import numpy as np
from scipy.sparse import lil_matrix
from sklearn.cluster import AgglomerativeClustering

log = logging.getLogger(__name__)

_GEOGRAPHIC_HIERARCHY_DDL = """
CREATE TABLE geographic_hierarchy (
    node_id VARCHAR,
    tier VARCHAR,
    parent_cluster_id VARCHAR,
    cluster_level INTEGER,
    distance DOUBLE
)
"""

_CLUSTER_CENTROIDS_DDL = """
CREATE TABLE cluster_centroids (
    cluster_id VARCHAR,
    tier VARCHAR,
    cluster_level INTEGER,
    n_nodes INTEGER,
    centroid_lat DOUBLE,
    centroid_lon DOUBLE,
    area_km2 DOUBLE,
    n_nodes_with_rental INTEGER
)
"""

_LINKAGE_MATRIX_DDL = """
CREATE TABLE linkage_matrix (
    tier VARCHAR,
    merge_step INTEGER,
    cluster_a INTEGER,
    cluster_b INTEGER,
    distance DOUBLE,
    n_obs INTEGER
)
"""


def _full_tree_linkage(
    features: np.ndarray,
    adjacency_csr: object,
    tier: str = "sal",
) -> list[dict[str, object]]:
    """Fit a full agglomerative tree (no cut) and return scipy-style merge rows.

    Each row: {tier, merge_step, cluster_a, cluster_b, distance, n_obs}. Node
    indices `[0..N-1]` are leaves; subsequent merges produce interior nodes
    `[N..2N-2]`. `n_obs` is the number of original leaves under the merged
    cluster. The `tier` parameter is stamped onto every row so SAL and LGA
    linkage matrices coexist in `ts_models.linkage_matrix`.
    """
    n = len(features)
    full_tree = AgglomerativeClustering(
        n_clusters=None,
        distance_threshold=0.0,
        linkage="average",
        connectivity=adjacency_csr,
        compute_distances=True,
        compute_full_tree=True,
    )
    full_tree.fit(features)
    children = np.asarray(full_tree.children_)
    distances = np.asarray(full_tree.distances_)
    # Walking the tree to populate cluster sizes. sklearn assigns indices
    # 0..N-1 to leaves; the k-th merge produces a new node with index N+k.
    sizes = np.ones(2 * n - 1, dtype=np.int64)
    rows: list[dict[str, object]] = []
    for step, ((a, b), dist) in enumerate(zip(children, distances, strict=True)):
        sizes[n + step] = sizes[a] + sizes[b]
        rows.append(
            {
                "tier": tier,
                "merge_step": int(step),
                "cluster_a": int(a),
                "cluster_b": int(b),
                "distance": float(dist),
                "n_obs": int(sizes[n + step]),
            }
        )
    return rows


def _sal_codes_with_rental(con: duckdb.DuckDBPyConnection) -> set[str]:
    """Return the set of `geospatial_codes` (== SAL_CODE21) values present in
    `rental_sales` at the suburb tier with a non-NULL median.

    Returns empty set if `rental_sales` table is absent — supports running
    sal-hierarchy ahead of (or independent of) the rental extract.
    """
    exists = con.execute(
        "SELECT 1 FROM information_schema.tables "
        "WHERE table_schema = 'main' AND table_name = 'rental_sales'"
    ).fetchone()
    if exists is None:
        return set()
    rows = con.execute(
        """
        SELECT DISTINCT geospatial_codes
        FROM rental_sales
        WHERE geospatial_type = 'suburb'
          AND statistic = 'median'
          AND data_type = 'rental'
          AND value IS NOT NULL
        """
    ).fetchall()
    return {str(r[0]) for r in rows}


def _adjacency_matrix(geoms: gpd.GeoSeries) -> lil_matrix:
    """Build a sparse `polygon.touches()` adjacency matrix (symmetric).

    Quadratic in N but N is small (~3000 SALs for VIC); the shapely
    `touches` short-circuits on disjoint bounding boxes so the constant
    factor is forgiving.
    """
    n = len(geoms)
    adj: lil_matrix = lil_matrix((n, n))
    values = geoms.values
    for i in range(n):
        for j in range(i + 1, n):
            if values[i].touches(values[j]):
                adj[i, j] = 1
                adj[j, i] = 1
    return adj


def build_tier_hierarchy(
    *,
    input_parquet: Path,
    output_duckdb: Path,
    ts_models_duckdb: Path,
    cut_levels: tuple[int, ...],
    tier: str,
    id_column: str,
) -> int:
    """Build a tier-agnostic agglomerative geographic hierarchy.

    Shared between G7 (SAL) and G8 (LGA). Persists per-(node, cut_level) rows
    into `geographic_hierarchy` and per-cluster aggregates into
    `cluster_centroids` (both in `output_duckdb`), plus the full scipy-style
    linkage matrix into `ts_models_duckdb.linkage_matrix`. Returns the
    geographic_hierarchy row count written for this tier.

    Idempotency: drops+recreates the per-tier rows it owns (filters by
    `tier`); leaves the other tier's rows untouched so sal-hierarchy and
    lga-hierarchy can run in either order without clobbering each other.
    """
    log.info("%s-hierarchy: reading %s", tier, input_parquet)
    gdf = gpd.read_parquet(input_parquet)
    if id_column not in gdf.columns:
        raise ValueError(f"input parquet missing {id_column} column; got {gdf.columns.tolist()}")

    # Filter out administrative-only rows with no polygon (e.g. SAL_CODE21
    # 29494 'No usual address (Vic.)' and 29797 'Migratory - Offshore -
    # Shipping (Vic.)' — they're statistical placeholders, not geographic
    # regions, so adjacency/centroid arithmetic is undefined).
    null_geom = gdf.geometry.isna()
    if null_geom.any():
        dropped = gdf.loc[null_geom, id_column].tolist()
        log.info(
            "%s-hierarchy: dropping %d rows with NULL geometry: %s", tier, len(dropped), dropped
        )
        gdf = gdf.loc[~null_geom].reset_index(drop=True)

    # Reproject to MGA Zone 55 so centroids + touches() resolve in metres.
    if gdf.crs is None:
        raise ValueError(f"input parquet {input_parquet} has no CRS set")
    if gdf.crs.to_epsg() != 7855:
        gdf = gdf.to_crs(epsg=7855)

    n = len(gdf)
    log.info("%s-hierarchy: %d polygons; building adjacency", tier, n)
    adj = _adjacency_matrix(gdf.geometry)

    sal_gdf = gdf  # alias for the rest of the legacy code path

    centroids = sal_gdf.geometry.centroid
    features = np.column_stack([centroids.x.to_numpy(), centroids.y.to_numpy()])
    sal_codes = sal_gdf[id_column].astype(str).tolist()
    # Compute centroids in the projected CRS (metres), THEN reproject the
    # centroid points to WGS84 for lat/lon persistence. Avoids geopandas's
    # "geometry in geographic CRS" warning that fires when computing centroids
    # on EPSG:4326 polygons directly.
    wgs84_centroids = gpd.GeoSeries(centroids, crs=sal_gdf.crs).to_crs(epsg=4326)
    lat_per_sal = wgs84_centroids.y.to_numpy()
    lon_per_sal = wgs84_centroids.x.to_numpy()
    area_per_sal_km2 = sal_gdf.geometry.area.to_numpy() / 1_000_000.0

    # Read rental-bearing SAL codes from the same DuckDB (the rental_sales
    # table may not be present, in which case n_nodes_with_rental = 0 for
    # all clusters).
    pre_con = duckdb.connect(str(output_duckdb))
    try:
        rental_codes = _sal_codes_with_rental(pre_con)
    finally:
        pre_con.close()
    has_rental_per_sal = np.array([code in rental_codes for code in sal_codes], dtype=bool)

    hier_rows: list[dict[str, object]] = []
    cluster_rows: list[dict[str, object]] = []
    for level in cut_levels:
        if level < 1 or level > n:
            raise ValueError(f"cut_level {level} out of bounds for {n} nodes (must be 1..{n})")
        log.info("%s-hierarchy: agglomerative clustering @ cut=%d", tier, level)
        clustering = AgglomerativeClustering(
            n_clusters=level,
            linkage="average",
            connectivity=adj.tocsr(),
        )
        labels = clustering.fit_predict(features)
        for sal_code, label in zip(sal_codes, labels, strict=True):
            hier_rows.append(
                {
                    "node_id": sal_code,
                    "tier": tier,
                    "parent_cluster_id": f"{tier}_L{level}_C{int(label)}",
                    "cluster_level": int(level),
                    "distance": 0.0,
                }
            )
        # Per-cluster centroids. Each `label ∈ [0, level)` aggregates its
        # member leaf nodes' lat/lon (unweighted mean), area sum, and rental-
        # bearing count.
        for cluster_idx in range(level):
            mask = labels == cluster_idx
            n_members = int(mask.sum())
            if n_members == 0:
                continue
            cluster_rows.append(
                {
                    "cluster_id": f"{tier}_L{level}_C{cluster_idx}",
                    "tier": tier,
                    "cluster_level": int(level),
                    "n_nodes": n_members,
                    "centroid_lat": float(lat_per_sal[mask].mean()),
                    "centroid_lon": float(lon_per_sal[mask].mean()),
                    "area_km2": float(area_per_sal_km2[mask].sum()),
                    "n_nodes_with_rental": int(has_rental_per_sal[mask].sum()),
                }
            )

    log.info(
        "%s-hierarchy: writing %d hierarchy rows + %d cluster rows to %s",
        tier,
        len(hier_rows),
        len(cluster_rows),
        output_duckdb,
    )
    hier_df = gpd.pd.DataFrame(hier_rows)
    cluster_df = gpd.pd.DataFrame(cluster_rows)
    con = duckdb.connect(str(output_duckdb))
    try:
        # Create fused tables if missing; preserve any other-tier rows.
        gh_exists = con.execute(
            "SELECT 1 FROM information_schema.tables "
            "WHERE table_schema = 'main' AND table_name = 'geographic_hierarchy'"
        ).fetchone()
        if gh_exists is None:
            con.execute(_GEOGRAPHIC_HIERARCHY_DDL)
        # Drop only this tier's existing rows so SAL + LGA can co-exist.
        con.execute("DELETE FROM geographic_hierarchy WHERE tier = ?", [tier])
        con.register("hier_src", hier_df)
        con.execute(
            "INSERT INTO geographic_hierarchy "
            "(node_id, tier, parent_cluster_id, cluster_level, distance) "
            "SELECT node_id, tier, parent_cluster_id, "
            "       CAST(cluster_level AS INTEGER), distance "
            "FROM hier_src"
        )
        con.unregister("hier_src")

        cc_exists = con.execute(
            "SELECT 1 FROM information_schema.tables "
            "WHERE table_schema = 'main' AND table_name = 'cluster_centroids'"
        ).fetchone()
        if cc_exists is None:
            con.execute(_CLUSTER_CENTROIDS_DDL)
        con.execute("DELETE FROM cluster_centroids WHERE tier = ?", [tier])
        con.register("cluster_src", cluster_df)
        con.execute(
            "INSERT INTO cluster_centroids "
            "(cluster_id, tier, cluster_level, n_nodes, centroid_lat, "
            " centroid_lon, area_km2, n_nodes_with_rental) "
            "SELECT cluster_id, tier, CAST(cluster_level AS INTEGER), "
            "       CAST(n_nodes AS INTEGER), centroid_lat, centroid_lon, "
            "       area_km2, CAST(n_nodes_with_rental AS INTEGER) "
            "FROM cluster_src"
        )
        con.unregister("cluster_src")
    finally:
        con.close()

    # T7.5: full-tree linkage matrix → ts_models.duckdb. Separate connection
    # because ts_models is a different (typically local-only) artifact, not
    # the deployed rental_sales.duckdb. Per-tier delete-and-insert to coexist.
    log.info("%s-hierarchy: fitting full tree for linkage matrix", tier)
    linkage_rows = _full_tree_linkage(features, adj.tocsr(), tier=tier)
    log.info(
        "%s-hierarchy: writing %d linkage rows to %s",
        tier,
        len(linkage_rows),
        ts_models_duckdb,
    )
    ts_models_duckdb.parent.mkdir(parents=True, exist_ok=True)
    linkage_df = gpd.pd.DataFrame(linkage_rows)
    ts_con = duckdb.connect(str(ts_models_duckdb))
    try:
        lm_exists = ts_con.execute(
            "SELECT 1 FROM information_schema.tables "
            "WHERE table_schema = 'main' AND table_name = 'linkage_matrix'"
        ).fetchone()
        if lm_exists is None:
            ts_con.execute(_LINKAGE_MATRIX_DDL)
        ts_con.execute("DELETE FROM linkage_matrix WHERE tier = ?", [tier])
        ts_con.register("linkage_src", linkage_df)
        ts_con.execute(
            "INSERT INTO linkage_matrix "
            "(tier, merge_step, cluster_a, cluster_b, distance, n_obs) "
            "SELECT tier, CAST(merge_step AS INTEGER), "
            "       CAST(cluster_a AS INTEGER), CAST(cluster_b AS INTEGER), "
            "       distance, CAST(n_obs AS INTEGER) "
            "FROM linkage_src"
        )
        ts_con.unregister("linkage_src")
    finally:
        ts_con.close()
    return len(hier_rows)


def run(
    *,
    input_sal_parquet: Path,
    output_duckdb: Path,
    ts_models_duckdb: Path,
    cut_levels: tuple[int, ...],
) -> int:
    """SAL-tier thin wrapper over `build_tier_hierarchy`. Signature preserved
    for the existing G7 CLI handler + tests; G8 uses build_lga_hierarchy.run().
    """
    return build_tier_hierarchy(
        input_parquet=input_sal_parquet,
        output_duckdb=output_duckdb,
        ts_models_duckdb=ts_models_duckdb,
        cut_levels=cut_levels,
        tier="sal",
        id_column="SAL_CODE21",
    )
