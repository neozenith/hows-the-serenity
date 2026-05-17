"""HDBSCAN + EVoC hierarchical clustering on polygon centroids.

Two methods produce two linkage matrices per tier:
  - hdbscan   — density-based, single-linkage minimum-spanning-tree
                cut into a hierarchy. We persist the full `single_linkage_tree_`
                (the scipy-format linkage matrix HDBSCAN exposes).
  - evoc      — extreme versatile outlier clustering. Exposes a similar
                hierarchical tree via `evoc.EVoC.linkage_tree_`.

Both operate on a SINGLE feature axis: the (lat, lon) centroid of each
polygon. The candidate set is filtered to codes that have observed
source data AND that we're imputing series for — that's the "target
subset" the analyst cares about for cluster correctness.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

import duckdb
import geopandas as gpd

# hdbscan and evoc are scientific Python packages that don't ship py.typed
# markers or stubs on PyPI. Suppress mypy's import-untyped warnings here
# rather than enabling untyped-imports globally, which would mask real
# missing-stub regressions elsewhere in the ETL.
import hdbscan  # type: ignore[import-untyped]
import numpy as np
from evoc import EVoC  # type: ignore[import-untyped]

log = logging.getLogger(__name__)


def cluster_hdbscan_linkage(
    centroids: dict[str, tuple[float, float]],
) -> list[dict[str, Any]]:
    """Run HDBSCAN on (lat, lon) centroids and emit the full single-linkage
    tree as scipy-style merge rows.

    Each row: {merge_idx, left_id, right_id, distance, size}.
      - merge_idx counts merges from 0; node id `C{merge_idx}` is the
        interior cluster produced by that merge.
      - left_id / right_id reference either a leaf code (str from
        `centroids`'s keys) or a previously-emitted interior id.
      - size is the total number of leaves under the merged cluster.

    HDBSCAN exposes `clusterer.single_linkage_tree_.to_numpy()` as an
    (n-1, 4) array of `(left_idx, right_idx, distance, size)`; we
    translate the idx → human-readable id so the output is consumable
    without re-running the algorithm to recover the leaf order.
    """
    codes = list(centroids.keys())
    if len(codes) < 2:
        return []
    matrix = np.array([centroids[c] for c in codes], dtype=float)
    # min_cluster_size=2 keeps every join in the tree — we want the full
    # linkage matrix, not HDBSCAN's flat cluster cut.
    # min_samples=1 collapses HDBSCAN's mutual-reachability metric to plain
    # Euclidean (core distance to a point's own 1-NN is 0), so the linkage
    # tree respects raw geographic distance between centroids rather than
    # density-corrected proximity. That's what the analyst expects when
    # eyeballing a spatial dendrogram of polygon centroids.
    clusterer = hdbscan.HDBSCAN(min_cluster_size=2, min_samples=1, gen_min_span_tree=True)
    clusterer.fit(matrix)
    return _linkage_array_to_rows(clusterer.single_linkage_tree_.to_numpy(), codes)


_CLUSTER_LINKAGE_DDL = """
CREATE TABLE IF NOT EXISTS cluster_linkage (
    tier VARCHAR NOT NULL,
    method VARCHAR NOT NULL,
    node_id VARCHAR NOT NULL,
    parent_id VARCHAR,
    size INTEGER NOT NULL,
    distance DOUBLE,
    is_leaf BOOLEAN NOT NULL
)
"""


def hdbscan_linkage_to_tree(
    linkage_rows: list[dict[str, Any]],
    leaf_codes: list[str],
) -> list[dict[str, Any]]:
    """Convert binary HDBSCAN linkage rows to the unified tree-node schema.

    For each binary merge, emit one interior node `C{merge_idx}` whose
    children are the merge's two operands. Leaves are emitted separately so
    every input code appears regardless of whether it shows up early in
    the linkage. Root (last merge) gets parent_id=None.
    """
    if not linkage_rows:
        return [
            {
                "node_id": code,
                "parent_id": None,
                "size": 1,
                "distance": None,
                "is_leaf": True,
            }
            for code in leaf_codes
        ]
    leaf_set = set(leaf_codes)
    parent_of: dict[str, str] = {}
    for row in linkage_rows:
        node_id = f"C{row['merge_idx']}"
        parent_of[row["left_id"]] = node_id
        parent_of[row["right_id"]] = node_id

    out: list[dict[str, Any]] = []
    for code in leaf_codes:
        out.append(
            {
                "node_id": code,
                "parent_id": parent_of.get(code),
                "size": 1,
                "distance": None,
                "is_leaf": True,
            }
        )
    for row in linkage_rows:
        node_id = f"C{row['merge_idx']}"
        out.append(
            {
                "node_id": node_id,
                "parent_id": parent_of.get(node_id),
                "size": int(row["size"]),
                "distance": float(row["distance"]),
                "is_leaf": False,
            }
        )
    # Sanity: anything that's still missing a parent (shouldn't happen with
    # consistent linkage rows that include all leaves) should remain orphaned
    # rather than silently re-parented.
    _ = leaf_set
    return out


def persist_tier_linkage(
    con: duckdb.DuckDBPyConnection,
    *,
    tier: str,
    centroids: dict[str, tuple[float, float]],
) -> None:
    """Run both HDBSCAN + EVoC on `centroids` and write rows for both
    methods into the `cluster_linkage` table, creating it if missing.

    The table is keyed by (tier, method, node_id); successive calls for
    different tiers/methods accumulate. Re-running for the SAME
    (tier, method) replaces those rows so the bake stays idempotent.
    """
    con.execute(_CLUSTER_LINKAGE_DDL)
    leaf_codes = list(centroids.keys())

    method_rows: dict[str, list[dict[str, Any]]] = {
        "hdbscan": hdbscan_linkage_to_tree(cluster_hdbscan_linkage(centroids), leaf_codes),
        "evoc": cluster_evoc_tree(centroids),
    }

    for method, rows in method_rows.items():
        con.execute(
            "DELETE FROM cluster_linkage WHERE tier = ? AND method = ?",
            [tier, method],
        )
        if not rows:
            continue
        # DuckDB will infer column types from the inserted Python values;
        # explicit casts keep DOUBLE vs INTEGER vs BOOLEAN unambiguous.
        con.executemany(
            """
            INSERT INTO cluster_linkage
                (tier, method, node_id, parent_id, size, distance, is_leaf)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    tier,
                    method,
                    r["node_id"],
                    r["parent_id"],
                    int(r["size"]),
                    None if r["distance"] is None else float(r["distance"]),
                    bool(r["is_leaf"]),
                )
                for r in rows
            ],
        )


def cluster_evoc_tree(
    centroids: dict[str, tuple[float, float]],
) -> list[dict[str, Any]]:
    """Run EVoC on (lat, lon) centroids and emit a unified tree as
    (node_id, parent_id, size, distance, is_leaf) rows.

    EVoC's `cluster_tree_` is a `dict[(layer, idx) → list[child_keys]]`
    representing an n-ary hierarchy: layer 0 is the most granular, the
    highest layer the apex. Leaves are layer-0 EVoC clusters that point to
    a list of `(0, leaf_idx)` tuples — those leaf indices map back to the
    input row order, which is `centroids.keys()` here.

    The output schema deliberately matches the HDBSCAN-tree path so the
    persistence layer + frontend renderer can stay method-agnostic. The
    n-ary shape (a parent can have >2 children) is supported by Cytoscape's
    layered layouts and is more faithful to EVoC's algorithm than forcing
    a binarisation.
    """
    codes = list(centroids.keys())
    if len(codes) < 2:
        return []
    matrix = np.array([centroids[c] for c in codes], dtype=float)
    # node_embedding_init=None skips the label-propagation PCA init that
    # needs ≥ ~30 rows to converge; reasonable default for our scale and
    # makes the test reproducible.
    model = EVoC(
        base_min_cluster_size=2,
        min_samples=2,
        n_neighbors=min(5, len(codes) - 1),
        random_state=0,
        node_embedding_init=None,
    )
    model.fit(matrix)
    return _evoc_tree_to_rows(model.cluster_tree_, codes)


def _evoc_tree_to_rows(
    tree: dict[tuple[int, int], list[tuple[int, int]]],
    leaf_codes: list[str],
) -> list[dict[str, Any]]:
    """Convert EVoC's `{(layer, idx) → [child_keys]}` tree to flat
    (node_id, parent_id, size, is_leaf) rows + a synthesised root.

    EVoC sometimes returns multiple top-level (no-parent) nodes when the
    algorithm partitions into disconnected components. We synthesise an
    `EVOC_ROOT` apex so the tree always has a single root, which keeps
    the Cytoscape layout clean (one mega-cluster at top, as the user
    specified).
    """

    # Index every key → string id "L{layer}_C{idx}" for stable ids.
    def _key_id(key: tuple[int, int]) -> str:
        return f"L{key[0]}_C{key[1]}"

    # parent map: child_key → parent_key (drawn from the tree dict's children).
    parent: dict[tuple[int, int], tuple[int, int]] = {}
    for parent_key, children in tree.items():
        for child in children:
            parent[child] = parent_key

    # Walk every node + every (0, leaf_idx) → leaf code mapping.
    rows: list[dict[str, Any]] = []
    seen_ids: set[str] = set()

    # Compute size by DFS from each node down to leaves.
    children_of: dict[tuple[int, int], list[tuple[int, int]]] = {
        k: list(v) for k, v in tree.items()
    }

    def _size(key: tuple[int, int]) -> int:
        ch = children_of.get(key, [])
        if not ch:
            return 1  # leaf-cluster size = 1 of itself; corrected for layer-0 below
        return sum(_size(c) for c in ch)

    # Emit a row per EVoC tree node.
    top_nodes: list[tuple[int, int]] = []
    for key in tree:
        node_id = _key_id(key)
        if node_id in seen_ids:
            continue
        seen_ids.add(node_id)
        p_key = parent.get(key)
        if p_key is None:
            top_nodes.append(key)
        rows.append(
            {
                "node_id": node_id,
                "parent_id": _key_id(p_key) if p_key is not None else None,
                "size": _size(key),
                "distance": None,
                "is_leaf": False,
            }
        )

    # Also emit a row per leaf code, parented by its layer-0 EVoC cluster.
    # Each layer-0 cluster's children list is a list of (0, leaf_idx) tuples
    # that index into `leaf_codes`.
    for parent_key, children in tree.items():
        if parent_key[0] != 0:
            continue
        for child in children:
            leaf_idx = child[1]
            if leaf_idx >= len(leaf_codes):
                continue  # defensive; shouldn't happen with the matched input
            code = leaf_codes[leaf_idx]
            if code in seen_ids:
                continue
            seen_ids.add(code)
            rows.append(
                {
                    "node_id": code,
                    "parent_id": _key_id(parent_key),
                    "size": 1,
                    "distance": None,
                    "is_leaf": True,
                }
            )

    # Ensure every input centroid has a leaf row. EVoC can drop noise points
    # — those go under a synthesised "EVOC_NOISE" parent so they're visible
    # in the dendrogram instead of silently dropped.
    missing = [c for c in leaf_codes if c not in seen_ids]
    if missing:
        rows.append(
            {
                "node_id": "EVOC_NOISE",
                "parent_id": None,
                "size": len(missing),
                "distance": None,
                "is_leaf": False,
            }
        )
        top_nodes.append((-1, -1))  # sentinel — joined under synthetic root below
        for code in missing:
            rows.append(
                {
                    "node_id": code,
                    "parent_id": "EVOC_NOISE",
                    "size": 1,
                    "distance": None,
                    "is_leaf": True,
                }
            )

    # Synthesise a single root if the EVoC tree gave us multiple tops.
    parent_targets = {r["node_id"]: r for r in rows if r["parent_id"] is None}
    if len(parent_targets) > 1:
        for r in rows:
            if r["parent_id"] is None:
                r["parent_id"] = "EVOC_ROOT"
        total_size = sum(r["size"] for r in rows if r["is_leaf"])
        rows.append(
            {
                "node_id": "EVOC_ROOT",
                "parent_id": None,
                "size": total_size,
                "distance": None,
                "is_leaf": False,
            }
        )

    return rows


def _linkage_array_to_rows(linkage: np.ndarray, leaf_codes: list[str]) -> list[dict[str, Any]]:
    """Translate a scipy-format linkage array into id-named merge rows.

    Indices in `linkage` are 0..N-1 for leaves and N..2N-2 for interior
    nodes produced by successive merges; `_id_for(idx)` resolves to the
    leaf's code or the synthetic `C{merge_idx}` for interior nodes.
    """
    n = len(leaf_codes)
    rows: list[dict[str, Any]] = []

    def _id_for(idx: int) -> str:
        return leaf_codes[idx] if idx < n else f"C{idx - n}"

    for step, row in enumerate(linkage):
        left, right, distance, size = row
        rows.append(
            {
                "merge_idx": int(step),
                "left_id": _id_for(int(left)),
                "right_id": _id_for(int(right)),
                "distance": float(distance),
                "size": int(size),
            }
        )
    return rows


def compute_centroids(
    geojson_path: Path,
    *,
    code_field: str,
    filter_codes: set[str] | None = None,
) -> dict[str, tuple[float, float]]:
    """Read a polygon geojson, return {code → (lat, lon) centroid} optionally
    restricted to `filter_codes`.

    `code_field` is the property that carries the polygon's identifier
    (e.g. "SAL_CODE21" for the suburb file, "LGA_CODE24" for the LGA file).
    The geometric centroid is computed in the geojson's native projection
    (already WGS84/EPSG:4326 for the project's geojsons), so result values
    are in (lat, lon) degrees.

    Filtering happens after read so the returned dict only carries the
    subset analysts actually care about (the source-data + imputed
    polygons), without forcing the caller to do the same filter again.
    """
    if not geojson_path.exists():
        raise FileNotFoundError(f"geojson not found: {geojson_path}")
    gdf = gpd.read_file(geojson_path)
    if code_field not in gdf.columns:
        raise KeyError(
            f"code_field '{code_field}' not in geojson properties "
            f"(have: {list(gdf.columns)[:8]}...)"
        )
    out: dict[str, tuple[float, float]] = {}
    for _, row in gdf.iterrows():
        code = str(row[code_field])
        if filter_codes is not None and code not in filter_codes:
            continue
        centroid = row.geometry.centroid
        out[code] = (float(centroid.y), float(centroid.x))
    return out


def emit_region_totals(
    *,
    sal_geojson: Path,
    lga_geojson: Path,
    observed_regions: Path,
    output_json: Path,
) -> dict[str, dict[str, int]]:
    """Write a small `region_totals.json` summary the /explore/overview page
    consumes for "how many SALs total / how many have source data" counts.

    Pre-computed at ETL time because loading the 11 MB SAL geojson on the
    overview page just for a feature-count would blow the page's TTFB
    budget. Output schema (stable for the frontend):

        {
          "sal": {"total": 2946, "observed": 760, "imputed_target": 760},
          "lga": {"total": 80,   "observed": 79,  "imputed_target": 79}
        }

    `imputed_target` equals the size of the observed-codes set today
    because every observed polygon is also being imputed (rollups +
    cross-tier dependencies); we publish it separately so the frontend
    doesn't conflate the two if that ever changes.
    """
    sal_gdf = gpd.read_file(sal_geojson)
    lga_gdf = gpd.read_file(lga_geojson)
    targets = load_target_codes(observed_regions)
    out = {
        "sal": {
            "total": len(sal_gdf),
            "observed": len(targets["sal"]),
            "imputed_target": len(targets["sal"]),
        },
        "lga": {
            "total": len(lga_gdf),
            "observed": len(targets["lga"]),
            "imputed_target": len(targets["lga"]),
        },
    }
    output_json.parent.mkdir(parents=True, exist_ok=True)
    output_json.write_text(json.dumps(out, indent=2), encoding="utf-8")
    log.info("cluster-linkage: wrote region totals → %s", output_json)
    return out


def run(
    *,
    sal_geojson: Path,
    lga_geojson: Path,
    observed_regions: Path,
    output_duckdb: Path,
) -> int:
    """Top-level entry point: compute centroids for the target subset of
    SALs + LGAs, run HDBSCAN + EVoC on each tier, persist into
    `cluster_linkage`. Returns the total row count written.

    Per-tier inputs:
      - SAL polygons come from `selected_sal_2021_aust_gda2020.geojson`,
        code field `SAL_CODE21`.
      - LGA polygons from `selected_lga_2024_aust_gda2020.geojson`,
        code field `LGA_CODE24`.
    The filter set is `observed_regions.json` — only polygons we have
    source data for AND are imputing series for.
    """
    targets = load_target_codes(observed_regions)
    log.info(
        "cluster-linkage: target subset sizes — sal=%d, lga=%d",
        len(targets["sal"]),
        len(targets["lga"]),
    )

    sal_centroids = compute_centroids(
        sal_geojson, code_field="SAL_CODE21", filter_codes=targets["sal"]
    )
    lga_centroids = compute_centroids(
        lga_geojson, code_field="LGA_CODE24", filter_codes=targets["lga"]
    )
    log.info(
        "cluster-linkage: resolved centroids — sal=%d, lga=%d",
        len(sal_centroids),
        len(lga_centroids),
    )

    con = duckdb.connect(str(output_duckdb))
    try:
        persist_tier_linkage(con, tier="sal", centroids=sal_centroids)
        persist_tier_linkage(con, tier="lga", centroids=lga_centroids)
        total = con.execute("SELECT COUNT(*) FROM cluster_linkage").fetchone()
    finally:
        con.close()
    n = int(total[0]) if total else 0
    log.info("cluster-linkage: wrote %d rows total into %s", n, output_duckdb)
    emit_region_totals(
        sal_geojson=sal_geojson,
        lga_geojson=lga_geojson,
        observed_regions=observed_regions,
        output_json=output_duckdb.parent / "region_totals.json",
    )
    return n


def load_target_codes(observed_path: Path) -> dict[str, set[str]]:
    """Read `observed_regions.json` → {"sal": {...}, "lga": {...}} as sets.

    This is the canonical "polygons we have source data for AND are
    imputing series for" filter. Centroid extraction + clustering both
    consume it so the analyst is never looking at a cluster that contains
    a code we have no signal on.
    """
    if not observed_path.exists():
        raise FileNotFoundError(f"observed_regions.json not found: {observed_path}")
    data = json.loads(observed_path.read_text(encoding="utf-8"))
    return {
        "sal": set(data.get("sal", [])),
        "lga": set(data.get("lga", [])),
    }
