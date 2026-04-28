"""Reconcile SAL polygons with rental_sales market groups.

Produces a JSON file that lets the frontend look up — given any SAL_CODE21
from the suburb MVT tiles — the rental_sales "market group" it belongs to,
the human-readable group label (which can span multiple SALs), and which
data series are available.

Why the rental and sales groupings are tracked SEPARATELY:
the rental_sales source aggregates the two data types differently. A single
SAL_CODE21 like 20018 (Albert Park) can simultaneously be:
  - in a *rental* group "20018-21677" labelled "Albert Park-Middle Park-West St Kilda"
  - in a *sales* group "20018" labelled "ALBERT PARK"
Rental tends to collapse 2-3 adjacent SALs into one rent-survey area
(~141 groups for ~600 SALs), while sales is mostly per-SAL (~761 groups).
Squashing both into a shared "group" loses the per-view label needed by the
SuburbPlot Rental/Sales toggle.

Output JSON shape (typed counterpart in `src/lib/suburb-mappings.ts`):

  {
    "version": <unix-epoch>,
    "salCodes": {
      "<sal_code_21>": {
        "salName":   <SAL_NAME21>,
        "stateName": <STE_NAME21>,
        "rental":    <Group | null>,
        "sales":     <Group | null>,
      },
      ...
    },
    "summary": {
      "totalSALs":          <int>,
      "withRentalData":     <int — SALs whose rental != null>,
      "withSalesData":      <int — SALs whose sales != null>,
      "rentalGroups":       <int>,
      "salesGroups":        <int>,
      "rentalGroupsMulti":  <int — rental groups with 2+ SALs collapsed>,
      "salesGroupsMulti":   <int — sales groups with 2+ SALs collapsed>,
      "salsNoData":         <int — SALs with neither rental nor sales>,
      "orphanGroupCodes":   <int — codes referenced by groups but not in SAL parquet>,
    }
  }

  type Group = {
    "groupCodes": <hyphen-joined codes string>,
    "groupLabel": <real-estate market label>,
    "groupSize":  <int — number of SAL codes in the group>,
  }
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any

import duckdb
import pandas as pd

log = logging.getLogger("etl.build_suburb_mappings")


def _load_groups(con: duckdb.DuckDBPyConnection, data_type: str) -> pd.DataFrame:
    """Distinct (geospatial_codes, geospatial) pairs for one data_type.

    Filtering on `data_type` means rental and sales groupings stay separate
    even when a SAL appears in different aggregations across the two.
    `geospatial_codes <> ''` strips a known degenerate row where the SAL
    code list is missing.
    """
    return con.execute(
        """
        SELECT
            geospatial_codes,
            ANY_VALUE(geospatial) AS geospatial_label
        FROM rental_sales
        WHERE geospatial_type = 'suburb'
          AND statistic = 'median'
          AND data_type = ?
          AND geospatial_codes IS NOT NULL
          AND geospatial_codes <> ''
        GROUP BY geospatial_codes
        """,
        [data_type],
    ).df()


def _invert_groups(groups_df: pd.DataFrame) -> dict[str, dict[str, Any]]:
    """Build sal_code → group entry. Each SAL belongs to at most one group
    *within the same data_type*, so collisions inside a single data_type
    indicate source-data inconsistency. We log loudly and last-wins.
    """
    sal_to_group: dict[str, dict[str, Any]] = {}
    collisions: list[str] = []
    for _, row in groups_df.iterrows():
        codes_str: str = row["geospatial_codes"]
        codes = codes_str.split("-")
        entry = {
            "groupCodes": codes_str,
            "groupLabel": row["geospatial_label"],
            "groupSize": len(codes),
        }
        for code in codes:
            if code in sal_to_group and sal_to_group[code]["groupCodes"] != codes_str:
                collisions.append(code)
            sal_to_group[code] = entry
    if collisions:
        log.warning(
            "%d SAL codes collide within a single data_type (last-wins): %s",
            len(collisions),
            collisions[:10],
        )
    return sal_to_group


def build_suburb_mappings(
    *,
    sal_parquet: Path,
    rental_sales_duckdb: Path,
    output_path: Path,
) -> Path:
    """Build the SAL→{rental,sales} reconciliation JSON."""
    if not sal_parquet.exists():
        raise FileNotFoundError(
            f"SAL parquet not found: {sal_parquet}. Run `etl extract sal` first."
        )
    if not rental_sales_duckdb.exists():
        raise FileNotFoundError(
            f"rental_sales DuckDB not found: {rental_sales_duckdb}. "
            "Run `etl extract rental-sales` first."
        )

    log.info("Reading SAL parquet: %s", sal_parquet)
    sal_df = pd.read_parquet(sal_parquet, columns=["SAL_CODE21", "SAL_NAME21", "STE_NAME21"])
    log.info("Loaded %d SAL features", len(sal_df))

    log.info("Reading rental_sales DuckDB: %s", rental_sales_duckdb)
    con = duckdb.connect(str(rental_sales_duckdb), read_only=True)
    try:
        rental_groups = _load_groups(con, "rental")
        sales_groups = _load_groups(con, "sales")
    finally:
        con.close()
    log.info(
        "Loaded %d rental groups, %d sales groups",
        len(rental_groups),
        len(sales_groups),
    )

    sal_to_rental = _invert_groups(rental_groups)
    sal_to_sales = _invert_groups(sales_groups)

    sal_codes: dict[str, dict[str, Any]] = {}
    for _, row in sal_df.iterrows():
        code = str(row["SAL_CODE21"])
        sal_codes[code] = {
            "salName": str(row["SAL_NAME21"]),
            "stateName": str(row["STE_NAME21"]),
            "rental": sal_to_rental.get(code),
            "sales": sal_to_sales.get(code),
        }

    # Codes referenced by rental_sales but missing from the SAL parquet.
    # Almost always state-filtered out — the SAL parquet is Victoria-only by
    # default while rental_sales sometimes has stragglers from interstate.
    referenced = set(sal_to_rental) | set(sal_to_sales)
    orphans = sorted(referenced - set(sal_codes))
    if orphans:
        log.warning(
            "%d SAL codes referenced by rental_sales but not in SAL parquet "
            "(state-filtered out?): %s",
            len(orphans),
            orphans[:10],
        )

    summary = {
        "totalSALs": len(sal_codes),
        "withRentalData": sum(1 for v in sal_codes.values() if v["rental"]),
        "withSalesData": sum(1 for v in sal_codes.values() if v["sales"]),
        "rentalGroups": len(rental_groups),
        "salesGroups": len(sales_groups),
        "rentalGroupsMulti": int(rental_groups["geospatial_codes"].str.contains("-").sum()),
        "salesGroupsMulti": int(sales_groups["geospatial_codes"].str.contains("-").sum()),
        "salsNoData": sum(1 for v in sal_codes.values() if not v["rental"] and not v["sales"]),
        "orphanGroupCodes": len(orphans),
    }

    output = {
        "version": int(time.time()),
        "salCodes": sal_codes,
        "summary": summary,
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(output, separators=(",", ":")))
    size_kb = output_path.stat().st_size / 1024
    log.info("Wrote suburb mappings → %s (%.1f KB)", output_path, size_kb)
    log.info("Summary: %s", json.dumps(summary, indent=2))
    return output_path
