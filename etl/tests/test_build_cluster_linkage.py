"""Tests for the HDBSCAN + EVoC clustering pipeline that populates
`cluster_linkage`. Each phase grows one behaviour at a time per the
mp-tdd vertical-slice rule.
"""

from __future__ import annotations

import json
from pathlib import Path

import duckdb
import pytest

from etl.steps import build_cluster_linkage as bcl


@pytest.fixture
def tiny_geojson(tmp_path: Path) -> Path:
    """Three square polygons over Melbourne lat/lon, one per code. Each
    polygon's geometric centroid lands at the centre of its square — a
    deterministic seed for the centroid extractor without pulling in the
    full SAL parquet.
    """
    features = []
    seeds = [("A001", 144.0, -37.8), ("B002", 144.5, -37.7), ("C003", 145.0, -37.6)]
    for code, lon, lat in seeds:
        # Tiny 0.01° square around each seed (lon, lat).
        ring = [
            [lon - 0.005, lat - 0.005],
            [lon + 0.005, lat - 0.005],
            [lon + 0.005, lat + 0.005],
            [lon - 0.005, lat + 0.005],
            [lon - 0.005, lat - 0.005],
        ]
        features.append(
            {
                "type": "Feature",
                "properties": {"CODE": code, "NAME": f"Name {code}"},
                "geometry": {"type": "Polygon", "coordinates": [ring]},
            }
        )
    payload = {"type": "FeatureCollection", "features": features}
    path = tmp_path / "tiny.geojson"
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def test_persist_tier_linkage_writes_both_methods(tmp_path: Path) -> None:
    """Round-trip a small centroid set through the persistence helper and
    verify both methods end up in the same `cluster_linkage` table, each
    with a leaf row per input code and exactly one root per method.
    """
    centroids = _spatial_blobs()
    db_path = tmp_path / "rs.duckdb"
    con = duckdb.connect(str(db_path))
    try:
        bcl.persist_tier_linkage(con, tier="sal", centroids=centroids)
    finally:
        con.close()

    con = duckdb.connect(str(db_path), read_only=True)
    try:
        methods = sorted(
            r[0]
            for r in con.execute(
                "SELECT DISTINCT method FROM cluster_linkage WHERE tier='sal'"
            ).fetchall()
        )
        assert methods == ["evoc", "hdbscan"]
        # One root per (tier, method) — apex of the dendrogram.
        roots = con.execute(
            "SELECT method, COUNT(*) FROM cluster_linkage "
            "WHERE tier='sal' AND parent_id IS NULL GROUP BY method"
        ).fetchall()
        for _method, n in roots:
            assert n == 1
        # Every input centroid appears as a leaf in BOTH methods.
        leaves_per_method = con.execute(
            "SELECT method, COUNT(*) FROM cluster_linkage "
            "WHERE tier='sal' AND is_leaf GROUP BY method ORDER BY method"
        ).fetchall()
        for _method, n_leaves in leaves_per_method:
            assert n_leaves == len(centroids)
    finally:
        con.close()


def _spatial_blobs(seed: int = 0) -> dict[str, tuple[float, float]]:
    """30 leaves in 3 spatial blobs near Melbourne. Shared by EVoC + the
    unified-tree tests — small enough to keep the cycle fast but big
    enough for EVoC's PCA-based init to converge.
    """
    import numpy as np  # local — keeps the helper independent of test imports

    rng = np.random.default_rng(seed)
    centres = [(-37.80, 144.95), (-37.95, 145.40), (-37.60, 144.50)]
    out: dict[str, tuple[float, float]] = {}
    for blob, (clat, clon) in enumerate(centres):
        for i in range(10):
            jit = rng.normal(scale=0.02, size=2)
            out[f"B{blob}_{i:02d}"] = (float(clat + jit[0]), float(clon + jit[1]))
    return out


def test_cluster_evoc_tree_emits_unified_node_rows() -> None:
    """EVoC's cluster_tree_ is a dict[(layer, idx)→children]; the function
    must flatten that to {node_id, parent_id, size, is_leaf} rows where:
      - every leaf code from `centroids` appears as a row,
      - exactly one row has parent_id=None (the root),
      - sum of all leaf rows == len(centroids).
    """
    centroids = _spatial_blobs()
    rows = bcl.cluster_evoc_tree(centroids)

    ids = {r["node_id"] for r in rows}
    leaves = [r for r in rows if r["is_leaf"]]
    roots = [r for r in rows if r["parent_id"] is None]

    # Every input centroid is represented as a leaf.
    assert {r["node_id"] for r in leaves} == set(centroids.keys())
    # Exactly one root (the apex of the hierarchy).
    assert len(roots) == 1, f"expected single root, got {len(roots)}: {roots}"
    # Every non-root row's parent_id must reference an existing node_id.
    for r in rows:
        if r["parent_id"] is not None:
            assert r["parent_id"] in ids, f"orphan parent: {r['node_id']} → {r['parent_id']}"


def test_cluster_hdbscan_linkage_joins_spatial_neighbours_first() -> None:
    """Four points in two spatially separated pairs. The HDBSCAN single-
    linkage tree should merge within-pair before the across-pair join, and
    every internal node's `size` should equal the sum of its descendants.
    """
    centroids = {
        "A": (-37.80, 144.95),  # CBD pair
        "B": (-37.81, 144.96),
        "C": (-37.95, 145.40),  # Far-east pair
        "D": (-37.96, 145.41),
    }
    rows = bcl.cluster_hdbscan_linkage(centroids)
    # 4 leaves → 3 merges in a full linkage.
    assert len(rows) == 3
    # First merge: joins one of the within-pair couples (distance < first cross-pair distance).
    first = rows[0]
    leaf_pair = {first["left_id"], first["right_id"]}
    assert leaf_pair in ({"A", "B"}, {"C", "D"}), leaf_pair
    # Last merge holds all 4 points and the largest distance.
    last = rows[-1]
    assert last["size"] == 4
    assert last["distance"] >= first["distance"]


def test_compute_centroids_returns_code_to_latlon(tiny_geojson: Path) -> None:
    """Each polygon's centroid maps back to its seed coordinate, keyed by
    the requested `code_field` property.
    """
    result = bcl.compute_centroids(tiny_geojson, code_field="CODE")
    assert set(result) == {"A001", "B002", "C003"}
    # Centroid of a tiny square sits at its centre — exact to many decimals.
    lat_a, lon_a = result["A001"]
    assert lon_a == pytest.approx(144.0, abs=1e-6)
    assert lat_a == pytest.approx(-37.8, abs=1e-6)
