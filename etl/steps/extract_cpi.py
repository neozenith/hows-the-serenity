"""Extract ABS Melbourne All-groups Consumer Price Index as a quarterly time series.

Pulled directly from the ABS SDMX-JSON API
(https://api.data.abs.gov.au) — series key `1.10001.10.2.Q` decodes as:

  MEASURE=1      → Index numbers (not %change)
  INDEX=10001    → All groups CPI
  TSEST=10       → Original (not seasonally adjusted)
  REGION=2       → Melbourne
  FREQUENCY=Q    → Quarterly

Index base period is 2011-12 = 100.0 (the ABS reference).

Output schema (parquet + DuckDB table `cpi`):
  - region        VARCHAR  ("Melbourne" for now; the only thing we fetch)
  - time_bucket   DATE     (first day of the quarter)
  - index_value   DOUBLE   (CPI index number, base 2011-12=100)

The DuckDB table lives alongside `rental_sales` inside the same
`rental_sales.duckdb` file so the frontend can join CPI against rental
and sales medians without a second fetch. SuburbPlot reads it as a
second-y-axis line to let users eyeball "is this suburb's rent growing
faster than general inflation".
"""

from __future__ import annotations

import datetime as dt
import json
import logging
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.request import Request, urlopen

import duckdb
import pandas as pd

log = logging.getLogger("etl.steps.extract_cpi")

# Stable ABS API endpoint. The dataflow ID `CPI` and dimension key form
# are documented at https://api.data.abs.gov.au/rest/dataflow/ABS/CPI .
_ABS_CPI_URL = (
    "https://api.data.abs.gov.au/data/CPI/1.10001.10.2.Q?startPeriod=1999-Q1&format=jsondata"
)

# ABS returns SDMX-JSON; we ask for `format=jsondata` which keeps the
# response under ~50 KB for our single series.
_REQUEST_HEADERS = {
    "Accept": "application/vnd.sdmx.data+json;version=1.0.0-wd",
    "User-Agent": "hows-the-serenity-etl/0.1 (+https://github.com/joshpeak/hows-the-serenity)",
}


def _fetch_sdmx_json(url: str) -> dict[str, Any]:
    """Fetch and parse SDMX-JSON from the ABS API."""
    req = Request(url, headers=_REQUEST_HEADERS)
    log.info("GET %s", url)
    try:
        with urlopen(req, timeout=30) as resp:
            payload = resp.read()
    except URLError as e:
        raise RuntimeError(
            f"ABS CPI fetch failed: {e}. The ABS SDMX API may have changed; "
            f"verify the dataflow key against https://api.data.abs.gov.au/rest/dataflow/ABS/CPI"
        ) from e
    parsed: dict[str, Any] = json.loads(payload)
    return parsed


def _quarter_label_to_date(label: str) -> dt.date:
    """ABS time labels look like '2024-Q3' → first day of the quarter's LAST month.

    Anchored to the last month of the quarter (Q1=Mar, Q2=Jun, Q3=Sep,
    Q4=Dec) on the first day, e.g. '2025-Q3' → 2025-09-01.

    This matches the rental data's `time_bucket` convention — the source
    xlsx labels columns as "Sep 2025" for the Q3 2025 moving annual
    average, which the rental extractor parses via `%b %Y` to land on
    2025-09-01. Without this match, plotly draws the same-quarter CPI
    and rental points two months apart on the shared x-axis.
    """
    year_str, q_str = label.split("-Q")
    year = int(year_str)
    quarter = int(q_str)
    if not 1 <= quarter <= 4:
        raise ValueError(f"Unexpected quarter label {label!r}")
    return dt.date(year, quarter * 3, 1)


def _parse_sdmx(payload: dict[str, Any]) -> pd.DataFrame:
    """Pull the (time, value) pairs out of an ABS SDMX-JSON response.

    The structure we navigate is:
        data.dataSets[0].series["0:0:0:0:0"].observations["<i>"][0]
        data.structure.dimensions.observation[0].values[<i>].id   ← time label

    `data.structure` is singular (the older SDMX-JSON spec used an array
    `structures[]`; ABS's current API returns the singular form). The
    observation dimension at position 0 is TIME_PERIOD because we asked
    for a single series, so all the other key dimensions are flattened
    server-side.
    """
    try:
        data = payload["data"]
        structure = data["structure"]
        time_values = structure["dimensions"]["observation"][0]["values"]
        series_dict = data["dataSets"][0]["series"]
    except (KeyError, IndexError) as e:
        raise RuntimeError(
            f"ABS SDMX response shape unexpected: {e}. Schema may have changed."
        ) from e

    if not series_dict:
        raise RuntimeError("ABS SDMX response carried no series rows")
    # We only requested one series, so any series key works.
    series = next(iter(series_dict.values()))
    observations = series["observations"]

    rows: list[dict[str, Any]] = []
    for pos_str, obs in observations.items():
        # obs is [value, ...flags]. value can be a number or None for
        # suppressed observations — we drop nulls rather than carry them.
        if not obs or obs[0] is None:
            continue
        time_label = time_values[int(pos_str)]["id"]
        rows.append(
            {
                "region": "Melbourne",
                "time_bucket": _quarter_label_to_date(time_label),
                "index_value": float(obs[0]),
            }
        )
    df = pd.DataFrame(rows).sort_values("time_bucket").reset_index(drop=True)
    if df.empty:
        raise RuntimeError("ABS SDMX response produced zero usable observations")
    return df


def run(
    *,
    output_parquet: Path,
    output_duckdb: Path,
) -> int:
    """Fetch ABS Melbourne CPI, write to parquet, attach into rental_sales.duckdb.

    Returns the number of quarterly observations written.

    The DuckDB write replaces any existing `cpi` table — idempotent so
    re-runs reflect the latest ABS release without manual cleanup.
    """
    payload = _fetch_sdmx_json(_ABS_CPI_URL)
    df = _parse_sdmx(payload)
    log.info(
        "Parsed %d quarterly observations (%s → %s)",
        len(df),
        df["time_bucket"].min(),
        df["time_bucket"].max(),
    )

    output_parquet.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(output_parquet, index=False)
    log.info("Wrote parquet: %s (%.1f KB)", output_parquet, output_parquet.stat().st_size / 1024)

    if not output_duckdb.exists():
        raise FileNotFoundError(
            f"Target DuckDB not found at {output_duckdb}. "
            f"Run `etl extract rental-sales` first to create it."
        )
    con = duckdb.connect(str(output_duckdb))
    try:
        # Register the DataFrame for the SQL CREATE — DuckDB reads it
        # directly from memory, no temp file.
        con.register("cpi_source", df)
        con.execute("DROP TABLE IF EXISTS cpi")
        con.execute("CREATE TABLE cpi AS SELECT * FROM cpi_source")
        n_row = con.execute("SELECT COUNT(*) FROM cpi").fetchone()
        n = n_row[0] if n_row else 0
        log.info("Wrote DuckDB table 'cpi': %d rows (db: %s)", n, output_duckdb)
    finally:
        con.close()

    return len(df)
