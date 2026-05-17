"""LGA geographic agglomerative hierarchy builder (G8).

Thin wrapper around `build_sal_hierarchy.build_tier_hierarchy` with
`tier='lga'` and `id_column='LGA_CODE24'`. Writes into the same fused
`geographic_hierarchy` + `cluster_centroids` tables that G7 owns, with
the `tier` column discriminating SAL vs LGA rows; the linkage matrix
goes to the same `ts_models.linkage_matrix` table, tagged similarly.
"""

from __future__ import annotations

from pathlib import Path

from etl.steps.build_sal_hierarchy import build_tier_hierarchy


def run(
    *,
    input_lga_parquet: Path,
    output_duckdb: Path,
    ts_models_duckdb: Path,
    cut_levels: tuple[int, ...],
) -> int:
    """Build the LGA agglomerative hierarchy.

    Mirrors `build_sal_hierarchy.run()` for the LGA tier — see
    `build_tier_hierarchy()` for the shared implementation.
    """
    return build_tier_hierarchy(
        input_parquet=input_lga_parquet,
        output_duckdb=output_duckdb,
        ts_models_duckdb=ts_models_duckdb,
        cut_levels=cut_levels,
        tier="lga",
        id_column="LGA_CODE24",
    )
