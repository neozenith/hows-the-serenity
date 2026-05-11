"""argparse CLI for the ETL pipeline.

Follows .claude/rules/python/cli.md:
- argparse only (no click/typer)
- _help closure as the default for incomplete subcommand paths
- `set_defaults(func=...)` on every leaf
- `status` verb for read-only state inspection
"""

from __future__ import annotations

import argparse
import logging
import subprocess
import sys
import time
from collections.abc import Callable
from pathlib import Path

from etl.config import (
    BOUNDARIES_ORIGINALS,
    CONVERTED_DIR,
    ISOCHRONE_DURATIONS,
    ISOCHRONES_ORIGINALS,
    LGA_SIMPLIFY_TOLERANCE,
    PTV_COMMUTE_HULL_KEEP_PROPERTIES,
    PTV_LINE_KEEP_PROPERTIES,
    PTV_LINES_GEOJSON,
    PTV_MODE_LABELS,
    PTV_MODES,
    PTV_ORIGINALS,
    PTV_STOP_KEEP_PROPERTIES,
    PTV_STOPS_GEOJSON,
    PUBLIC_DATA_DIR,
    RENTAL_SALES_DUCKDB,
    RENTAL_SALES_INPUT_DIR,
    RENTAL_SALES_PARQUET,
    RENTAL_SALES_SCHEMA,
    SAL_SIMPLIFY_TOLERANCE,
)
from etl.logging_setup import configure
from etl.steps import (
    build_suburb_mappings,
    extract_isochrones,
    extract_ptv,
    extract_rental_sales,
    extract_sal,
    publish_commute_hulls,
    publish_lga,
    publish_region_centroids,
    publish_region_h3_cells,
    publish_region_names,
    publish_sal,
    tile_isochrone,
    tile_ptv,
    tile_sal,
)

# ---- Default file paths (single source of truth for CLI defaults) -----------

SAL_ZIP = BOUNDARIES_ORIGINALS / "SAL_2021_AUST_GDA2020_SHP.zip"
SAL_PARQUET = CONVERTED_DIR / "sal_2021_aust_gda2020.parquet"
SAL_GEOJSON = PUBLIC_DATA_DIR / "selected_sal_2021_aust_gda2020.geojson"
LGA_PARQUET = CONVERTED_DIR / "lga_2024_aust_gda2020.parquet"
LGA_GEOJSON = PUBLIC_DATA_DIR / "selected_lga_2024_aust_gda2020.geojson"
TILES_DIR = PUBLIC_DATA_DIR / "tiles"
SAL_TILES_DIR = TILES_DIR / "suburbs"
SUBURB_MAPPINGS_JSON = PUBLIC_DATA_DIR / "suburb_mappings.json"
SUBURB_CENTROIDS_JSON = PUBLIC_DATA_DIR / "suburb_centroids.json"
LGA_CENTROIDS_JSON = PUBLIC_DATA_DIR / "lga_centroids.json"
SUBURB_H3_CELLS_JSON = PUBLIC_DATA_DIR / "suburb_h3_cells.json"
LGA_H3_CELLS_JSON = PUBLIC_DATA_DIR / "lga_h3_cells.json"
SUBURB_NAMES_JSON = PUBLIC_DATA_DIR / "suburb_names.json"
LGA_NAMES_JSON = PUBLIC_DATA_DIR / "lga_names.json"

ISO_FOOT_DIR = ISOCHRONES_ORIGINALS / "foot"
ISO_FOOT_PARQUET = CONVERTED_DIR / "isochrones_foot.parquet"


def _ptv_lines_parquet(mode: str) -> Path:
    return CONVERTED_DIR / f"ptv_lines_{mode}.parquet"


def _ptv_stops_parquet(mode: str) -> Path:
    return CONVERTED_DIR / f"ptv_stops_{mode}.parquet"


def _ptv_lines_tiles_dir(mode: str) -> Path:
    return PUBLIC_DATA_DIR / "tiles" / f"ptv_lines_{mode}"


def _ptv_stops_tiles_dir(mode: str) -> Path:
    return PUBLIC_DATA_DIR / "tiles" / f"ptv_stops_{mode}"


def _commute_hulls_source(mode: str) -> Path:
    return PTV_ORIGINALS / f"ptv_commute_tier_hulls_{mode}.geojson"


def _commute_hulls_published(mode: str) -> Path:
    return PUBLIC_DATA_DIR / f"commute_hulls_{mode}.geojson"


# ---- Subcommand handlers ----------------------------------------------------


def cmd_extract_sal(args: argparse.Namespace) -> None:
    extract_sal.run(
        input_zip=args.input,
        output_parquet=args.output,
        state_filter=args.state,
    )


def cmd_publish_sal(args: argparse.Namespace) -> None:
    publish_sal.run(
        input_parquet=args.input,
        output_geojson=args.output,
        simplify_tolerance=args.simplify_tolerance,
    )


def cmd_tile_sal(args: argparse.Namespace) -> None:
    tile_sal.run(
        input_parquet=args.input,
        output_dir=args.output,
        layer_name=args.layer_name,
        min_zoom=args.min_zoom,
        max_zoom=args.max_zoom,
    )


def cmd_extract_isochrones(args: argparse.Namespace) -> None:
    extract_isochrones.run(
        input_dir=args.input,
        output_parquet=args.output,
        durations=tuple(args.durations),
        mode=args.mode,
    )


def cmd_tile_isochrone(args: argparse.Namespace) -> None:
    tile_isochrone.run(
        input_parquet=args.input,
        duration=args.duration,
        output_dir=args.output,
        mode=args.mode,
        min_zoom=args.min_zoom,
        max_zoom=args.max_zoom,
    )


def cmd_extract_ptv_lines(args: argparse.Namespace) -> None:
    extract_ptv.run(
        input_geojson=PTV_LINES_GEOJSON,
        output_parquet=_ptv_lines_parquet(args.mode),
        keep_properties=PTV_LINE_KEEP_PROPERTIES,
        mode_filter=PTV_MODE_LABELS[args.mode],
        # Dissolve by route name — collapses the many shape/headsign
        # variants of each physical track into one MultiLineString,
        # deduping overlapping segments via unary_union. Train + V/Line
        # lines drop from thousands of features to ~15-20 each.
        dissolve_by="LONG_NAME",
    )


def cmd_extract_ptv_stops(args: argparse.Namespace) -> None:
    extract_ptv.run(
        input_geojson=PTV_STOPS_GEOJSON,
        output_parquet=_ptv_stops_parquet(args.mode),
        keep_properties=PTV_STOP_KEEP_PROPERTIES,
        mode_filter=PTV_MODE_LABELS[args.mode],
        # Matches upstream `utils.py:86-90` — collapses multi-platform
        # interchanges into one row per logical station name.
        dedupe_by="STOP_NAME",
    )


def cmd_tile_ptv_lines(args: argparse.Namespace) -> None:
    tile_ptv.run(
        input_parquet=_ptv_lines_parquet(args.mode),
        output_dir=PUBLIC_DATA_DIR / "tiles",
        layer_name="ptv_lines",
        layer_dir=f"ptv_lines_{args.mode}",
        keep_properties=PTV_LINE_KEEP_PROPERTIES,
    )


def cmd_tile_ptv_stops(args: argparse.Namespace) -> None:
    tile_ptv.run(
        input_parquet=_ptv_stops_parquet(args.mode),
        output_dir=PUBLIC_DATA_DIR / "tiles",
        layer_name="ptv_stops",
        layer_dir=f"ptv_stops_{args.mode}",
        keep_properties=PTV_STOP_KEEP_PROPERTIES,
    )


def cmd_publish_commute_hulls(args: argparse.Namespace) -> None:
    publish_commute_hulls.run(
        input_geojson=_commute_hulls_source(args.mode),
        output_geojson=_commute_hulls_published(args.mode),
        keep_properties=PTV_COMMUTE_HULL_KEEP_PROPERTIES,
    )


def cmd_publish_lga(args: argparse.Namespace) -> None:
    publish_lga.run(
        input_parquet=args.input,
        output_geojson=args.output,
        simplify_tolerance=args.simplify_tolerance,
    )


def cmd_extract_rental_sales(args: argparse.Namespace) -> None:
    extract_rental_sales.run(
        input_dir=args.input,
        schema_file=args.schema,
        sal_parquet=args.sal_parquet,
        lga_geojson=args.lga_geojson,
        output_parquet=args.output_parquet,
        output_duckdb=args.output_duckdb,
    )


def cmd_publish_suburb_mappings(args: argparse.Namespace) -> None:
    build_suburb_mappings.build_suburb_mappings(
        sal_parquet=args.sal_parquet,
        rental_sales_duckdb=args.rental_sales_duckdb,
        output_path=args.output,
    )


def cmd_publish_region_centroids(args: argparse.Namespace) -> None:
    publish_region_centroids.run(
        sal_parquet=args.sal_parquet,
        lga_geojson=args.lga_geojson,
        suburb_output=args.suburb_output,
        lga_output=args.lga_output,
    )


def cmd_publish_region_h3_cells(args: argparse.Namespace) -> None:
    publish_region_h3_cells.run(
        sal_parquet=args.sal_parquet,
        lga_geojson=args.lga_geojson,
        rental_sales_parquet=args.rental_sales_parquet,
        sal_resolution=args.sal_resolution,
        lga_resolution=args.lga_resolution,
        suburb_output=args.suburb_output,
        lga_output=args.lga_output,
    )


def cmd_publish_region_names(args: argparse.Namespace) -> None:
    publish_region_names.run(
        sal_parquet=args.sal_parquet,
        lga_geojson=args.lga_geojson,
        suburb_output=args.suburb_output,
        lga_output=args.lga_output,
    )


# --- `etl all` orchestration -------------------------------------------------
#
# The full pipeline as a flat, ordered list of subcommand argv tuples. Each
# tuple becomes a fresh `python -m etl <args>` subprocess so the OS reclaims
# memory between steps — peak RSS for the whole pipeline is bounded to the
# worst single step, instead of accumulating across the run. Per-step memory
# budgets are still each step's responsibility (see publish_region_h3_cells
# for an example of streaming + GC); subprocess isolation is the second
# defence so even a buggy step can't leak into later ones.
#
# Order is dependency-driven: extract feeds publish + tile, publish-lga is
# read by extract-rental-sales' downstream consumers, publish-region-h3-cells
# depends on the rental_sales parquet already existing, etc.
PIPELINE_STEPS: tuple[tuple[str, ...], ...] = (
    # --- extract phase ---
    ("extract", "sal"),
    ("extract", "rental-sales"),
    ("extract", "isochrones"),
    *tuple(("extract", "ptv-lines", "--mode", m) for m in PTV_MODES),
    *tuple(("extract", "ptv-stops", "--mode", m) for m in PTV_MODES),
    # --- publish phase ---
    ("publish", "sal"),
    ("publish", "lga"),
    *tuple(("publish", "commute-hulls", "--mode", m) for m in ("metro_train", "metro_tram")),
    ("publish", "suburb-mappings"),
    ("publish", "region-h3-cells"),
    ("publish", "region-names"),
    ("publish", "region-centroids"),
    # --- tile phase ---
    ("tile", "sal"),
    *tuple(("tile", "isochrone", "--duration", str(d)) for d in ISOCHRONE_DURATIONS),
    *tuple(("tile", "ptv-lines", "--mode", m) for m in PTV_MODES),
    *tuple(("tile", "ptv-stops", "--mode", m) for m in PTV_MODES),
)


def cmd_all(args: argparse.Namespace) -> None:
    """Run the full pipeline as a sequence of subprocesses.

    Subprocess isolation per step means each step starts with a fresh
    Python heap — peak memory for the whole run is bounded to the worst
    single step's transient peak, not the cumulative sum. The user's
    laptop crash on a prior monolithic-bash run is precisely the failure
    mode this guards against.

    Stops on the first non-zero exit. The failing step's stdout/stderr
    is inherited (already streamed live), so the user sees exactly what
    went wrong and where in the sequence.
    """
    log = logging.getLogger("etl.cli.all")
    verbose: bool = bool(getattr(args, "verbose", False))
    only_phase: str | None = getattr(args, "only", None)

    steps = [s for s in PIPELINE_STEPS if only_phase is None or s[0] == only_phase]
    if not steps:
        log.error("No steps match --only=%r (expected one of: extract, publish, tile)", only_phase)
        raise SystemExit(2)

    total = len(steps)
    log.info(
        "Running %d pipeline step%s sequentially (subprocess-isolated)",
        total,
        "" if total == 1 else "s",
    )
    overall_start = time.monotonic()

    for idx, step in enumerate(steps, start=1):
        # `python -m etl` re-enters the same CLI we're in now, so the
        # child's argparse sees the same handlers we just defined. The
        # verbose flag is forwarded so the child logs at the same level.
        argv = [sys.executable, "-m", "etl"]
        if verbose:
            argv.append("--verbose")
        argv.extend(step)

        label = " ".join(step)
        log.info("[%d/%d] etl %s", idx, total, label)
        step_start = time.monotonic()
        # check=False so we can format our own error message and exit
        # with the child's exit code rather than wrapping it in a
        # CalledProcessError stack trace.
        result = subprocess.run(argv, check=False)
        elapsed = time.monotonic() - step_start
        if result.returncode != 0:
            log.error(
                "[%d/%d] FAILED in %.1fs: etl %s (exit %d)",
                idx,
                total,
                elapsed,
                label,
                result.returncode,
            )
            raise SystemExit(result.returncode)
        log.info("[%d/%d] OK in %.1fs: etl %s", idx, total, elapsed, label)

    overall_elapsed = time.monotonic() - overall_start
    log.info("All %d steps completed in %.1fs", total, overall_elapsed)


def cmd_status(_: argparse.Namespace) -> None:
    rows: list[tuple[str, Path, str]] = [
        ("SAL zip (input)", SAL_ZIP, "file"),
        ("SAL parquet (intermediate)", SAL_PARQUET, "file"),
        ("SAL geojson (published)", SAL_GEOJSON, "file"),
        ("SAL MVT tiles", SAL_TILES_DIR, "dir"),
        ("Isochrones source dir", ISO_FOOT_DIR, "dir"),
        ("Isochrones parquet", ISO_FOOT_PARQUET, "file"),
        *[
            (f"Iso foot {d}min MVT tiles", TILES_DIR / f"iso_foot_{d}", "dir")
            for d in ISOCHRONE_DURATIONS
        ],
        ("PTV source dir", PTV_ORIGINALS, "dir"),
        *[(f"PTV lines {m} parquet", _ptv_lines_parquet(m), "file") for m in PTV_MODES],
        *[(f"PTV stops {m} parquet", _ptv_stops_parquet(m), "file") for m in PTV_MODES],
        *[(f"PTV lines {m} MVT tiles", _ptv_lines_tiles_dir(m), "dir") for m in PTV_MODES],
        *[(f"PTV stops {m} MVT tiles", _ptv_stops_tiles_dir(m), "dir") for m in PTV_MODES],
        ("Rental/sales DuckDB", RENTAL_SALES_DUCKDB, "file"),
        ("Suburb mappings JSON", SUBURB_MAPPINGS_JSON, "file"),
        ("Suburb centroids JSON", SUBURB_CENTROIDS_JSON, "file"),
        ("LGA centroids JSON", LGA_CENTROIDS_JSON, "file"),
        ("Suburb H3 cells JSON", SUBURB_H3_CELLS_JSON, "file"),
        ("LGA H3 cells JSON", LGA_H3_CELLS_JSON, "file"),
        ("Suburb names JSON", SUBURB_NAMES_JSON, "file"),
        ("LGA names JSON", LGA_NAMES_JSON, "file"),
    ]
    print(f"{'Artifact':<30}  {'Exists':<7}  {'Size':>10}  Path")
    print("-" * 100)
    for label, path, kind in rows:
        exists = path.exists()
        if not exists:
            size = "—"
        elif kind == "dir":
            total = sum(p.stat().st_size for p in path.rglob("*") if p.is_file())
            count = sum(1 for _ in path.rglob("*.pbf"))
            size = f"{total / 1_048_576:.1f} MB ({count} pbf)"
        else:
            size = f"{path.stat().st_size / 1_048_576:.1f} MB"
        print(f"{label:<30}  {'yes' if exists else 'no':<7}  {size:>10}  {path}")


# ---- Parser construction ----------------------------------------------------


def _help(parser: argparse.ArgumentParser) -> Callable[[argparse.Namespace], None]:
    """Default handler that prints `parser`'s help when no subcommand was given."""

    def _print_help(_: argparse.Namespace) -> None:
        parser.print_help()

    return _print_help


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="etl",
        description="Geospatial ETL pipeline for the hows-the-serenity webapp.",
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="Enable debug logging")
    parser.set_defaults(func=_help(parser))
    top_sub = parser.add_subparsers(dest="cmd", required=False)

    # `etl extract <source>`
    extract_p = top_sub.add_parser("extract", help="Extract raw inputs to intermediate Parquet")
    extract_p.set_defaults(func=_help(extract_p))
    extract_sub = extract_p.add_subparsers(dest="extract_cmd", required=False)

    sal_extract = extract_sub.add_parser("sal", help="Extract SAL_2021 shapefile zip")
    sal_extract.add_argument("--input", type=Path, default=SAL_ZIP, help="Source zip")
    sal_extract.add_argument("--output", type=Path, default=SAL_PARQUET, help="Output parquet")
    sal_extract.add_argument(
        "--state",
        default="Victoria",
        help="STE_NAME21 to filter to (default: Victoria; pass empty string for all)",
    )
    sal_extract.set_defaults(func=cmd_extract_sal)

    rental_sales_extract = extract_sub.add_parser(
        "rental-sales",
        help="Extract rental + sales medians from xlsx -> parquet + duckdb",
    )
    rental_sales_extract.add_argument(
        "--input",
        type=Path,
        default=RENTAL_SALES_INPUT_DIR,
        help="Source dir containing rental_sales/{rental,sales}/*.xlsx",
    )
    rental_sales_extract.add_argument(
        "--schema",
        type=Path,
        default=RENTAL_SALES_SCHEMA,
        help="YAML schema mapping for the xlsx files",
    )
    rental_sales_extract.add_argument(
        "--sal-parquet",
        type=Path,
        default=SAL_PARQUET,
        help="SAL boundary parquet (provides SAL_NAME21 -> SAL_CODE21 lookup)",
    )
    rental_sales_extract.add_argument(
        "--lga-geojson",
        type=Path,
        default=LGA_GEOJSON,
        help="LGA boundary GeoJSON (provides LGA_NAME24 -> LGA_CODE24 lookup)",
    )
    rental_sales_extract.add_argument(
        "--output-parquet",
        type=Path,
        default=RENTAL_SALES_PARQUET,
        help="Output parquet checkpoint",
    )
    rental_sales_extract.add_argument(
        "--output-duckdb",
        type=Path,
        default=RENTAL_SALES_DUCKDB,
        help="Output DuckDB file (consumed by the frontend)",
    )
    rental_sales_extract.set_defaults(func=cmd_extract_rental_sales)

    iso_extract = extract_sub.add_parser(
        "isochrones",
        help="Concat + dissolve per-stop walking isochrones into corridor parquet",
    )
    iso_extract.add_argument(
        "--input",
        type=Path,
        default=ISO_FOOT_DIR,
        help="Directory of per-stop *.geojson files",
    )
    iso_extract.add_argument("--output", type=Path, default=ISO_FOOT_PARQUET, help="Output parquet")
    iso_extract.add_argument(
        "--durations",
        type=int,
        nargs="+",
        default=list(ISOCHRONE_DURATIONS),
        help="Contour durations to keep (minutes)",
    )
    iso_extract.add_argument("--mode", default="foot", help="Travel mode label")
    iso_extract.set_defaults(func=cmd_extract_isochrones)

    ptv_lines_extract = extract_sub.add_parser(
        "ptv-lines", help="Extract PTV line GeoJSON to pruned parquet"
    )
    ptv_lines_extract.add_argument(
        "--mode", choices=PTV_MODES, default="metro_train", help="PTV mode"
    )
    ptv_lines_extract.set_defaults(func=cmd_extract_ptv_lines)

    ptv_stops_extract = extract_sub.add_parser(
        "ptv-stops", help="Extract PTV stop GeoJSON to pruned parquet"
    )
    ptv_stops_extract.add_argument(
        "--mode", choices=PTV_MODES, default="metro_train", help="PTV mode"
    )
    ptv_stops_extract.set_defaults(func=cmd_extract_ptv_stops)

    # `etl publish <source>`
    publish_p = top_sub.add_parser("publish", help="Publish intermediate to public/data GeoJSON")
    publish_p.set_defaults(func=_help(publish_p))
    publish_sub = publish_p.add_subparsers(dest="publish_cmd", required=False)

    sal_publish = publish_sub.add_parser("sal", help="Publish SAL_2021 GeoJSON")
    sal_publish.add_argument("--input", type=Path, default=SAL_PARQUET, help="Source parquet")
    sal_publish.add_argument("--output", type=Path, default=SAL_GEOJSON, help="Output GeoJSON")
    sal_publish.add_argument(
        "--simplify-tolerance",
        type=float,
        default=SAL_SIMPLIFY_TOLERANCE,
        help="Douglas-Peucker tolerance in degrees (0 = no simplification)",
    )
    sal_publish.set_defaults(func=cmd_publish_sal)

    lga_publish = publish_sub.add_parser("lga", help="Publish LGA_2024 (Vic) GeoJSON")
    lga_publish.add_argument("--input", type=Path, default=LGA_PARQUET, help="Source parquet")
    lga_publish.add_argument("--output", type=Path, default=LGA_GEOJSON, help="Output GeoJSON")
    lga_publish.add_argument(
        "--simplify-tolerance",
        type=float,
        default=LGA_SIMPLIFY_TOLERANCE,
        help="Douglas-Peucker tolerance in degrees (0 = no simplification)",
    )
    lga_publish.set_defaults(func=cmd_publish_lga)

    hulls_publish = publish_sub.add_parser(
        "commute-hulls",
        help="Publish PTV commute-tier hulls (4 polygons per mode) as static GeoJSON",
    )
    hulls_publish.add_argument("--mode", choices=PTV_MODES, default="metro_train", help="PTV mode")
    hulls_publish.set_defaults(func=cmd_publish_commute_hulls)

    suburb_mappings_publish = publish_sub.add_parser(
        "suburb-mappings",
        help=(
            "Reconcile SAL_2021 polygons with rental_sales market groups "
            "into a JSON lookup the SPA fetches at startup"
        ),
    )
    suburb_mappings_publish.add_argument(
        "--sal-parquet",
        type=Path,
        default=SAL_PARQUET,
        help="SAL parquet (state-filtered, produced by `etl extract sal`)",
    )
    suburb_mappings_publish.add_argument(
        "--rental-sales-duckdb",
        type=Path,
        default=RENTAL_SALES_DUCKDB,
        help="rental_sales DuckDB (produced by `etl extract rental-sales`)",
    )
    suburb_mappings_publish.add_argument(
        "--output",
        type=Path,
        default=SUBURB_MAPPINGS_JSON,
        help="Output JSON path",
    )
    suburb_mappings_publish.set_defaults(func=cmd_publish_suburb_mappings)

    region_centroids_publish = publish_sub.add_parser(
        "region-centroids",
        help=(
            "Publish per-region representative-point centroids "
            "(SAL_CODE21 + LGA_CODE24 -> [lon, lat]) as JSON for the "
            "frontend HexagonLayer."
        ),
    )
    region_centroids_publish.add_argument(
        "--sal-parquet",
        type=Path,
        default=SAL_PARQUET,
        help="SAL parquet (state-filtered, produced by `etl extract sal`)",
    )
    region_centroids_publish.add_argument(
        "--lga-geojson",
        type=Path,
        default=LGA_GEOJSON,
        help="LGA GeoJSON (produced by `etl publish lga`)",
    )
    region_centroids_publish.add_argument(
        "--suburb-output",
        type=Path,
        default=SUBURB_CENTROIDS_JSON,
        help="Output JSON path for suburb centroids",
    )
    region_centroids_publish.add_argument(
        "--lga-output",
        type=Path,
        default=LGA_CENTROIDS_JSON,
        help="Output JSON path for LGA centroids",
    )
    region_centroids_publish.set_defaults(func=cmd_publish_region_centroids)

    region_h3_publish = publish_sub.add_parser(
        "region-h3-cells",
        help=(
            "Publish per-region H3 cell coverage maps (SAL_CODE21 + LGA_CODE24 "
            "-> set of H3 cell IDs) for every region that has rental_sales "
            "data. SAL and LGA tiers use independent resolutions because "
            "LGA polygons are much larger and a uniform high resolution "
            "would explode cell counts into the millions."
        ),
    )
    region_h3_publish.add_argument(
        "--sal-parquet",
        type=Path,
        default=SAL_PARQUET,
        help="SAL parquet (state-filtered, produced by `etl extract sal`)",
    )
    region_h3_publish.add_argument(
        "--lga-geojson",
        type=Path,
        default=LGA_GEOJSON,
        help="LGA GeoJSON (produced by `etl publish lga`)",
    )
    region_h3_publish.add_argument(
        "--rental-sales-parquet",
        type=Path,
        default=RENTAL_SALES_PARQUET,
        help="rental_sales parquet (drives the has-data polygon filter)",
    )
    region_h3_publish.add_argument(
        "--sal-resolution",
        type=int,
        default=publish_region_h3_cells.SAL_RESOLUTION_DEFAULT,
        help="H3 resolution for SAL polygons; 9 ~= 400m (default)",
    )
    region_h3_publish.add_argument(
        "--lga-resolution",
        type=int,
        default=publish_region_h3_cells.LGA_RESOLUTION_DEFAULT,
        help="H3 resolution for LGA polygons; 7 ~= 1.2km (default)",
    )
    region_h3_publish.add_argument(
        "--suburb-output",
        type=Path,
        default=SUBURB_H3_CELLS_JSON,
        help="Output JSON path for suburb H3 cells",
    )
    region_h3_publish.add_argument(
        "--lga-output",
        type=Path,
        default=LGA_H3_CELLS_JSON,
        help="Output JSON path for LGA H3 cells",
    )
    region_h3_publish.set_defaults(func=cmd_publish_region_h3_cells)

    region_names_publish = publish_sub.add_parser(
        "region-names",
        help=(
            "Publish per-region name lookups (SAL_CODE21 -> SAL_NAME21, "
            "LGA_CODE24 -> LGA_NAME24) for hex-overlay tooltips."
        ),
    )
    region_names_publish.add_argument(
        "--sal-parquet", type=Path, default=SAL_PARQUET, help="SAL parquet"
    )
    region_names_publish.add_argument(
        "--lga-geojson", type=Path, default=LGA_GEOJSON, help="LGA GeoJSON"
    )
    region_names_publish.add_argument(
        "--suburb-output",
        type=Path,
        default=SUBURB_NAMES_JSON,
        help="Output JSON path for suburb names",
    )
    region_names_publish.add_argument(
        "--lga-output",
        type=Path,
        default=LGA_NAMES_JSON,
        help="Output JSON path for LGA names",
    )
    region_names_publish.set_defaults(func=cmd_publish_region_names)

    # `etl tile <source>`
    tile_p = top_sub.add_parser("tile", help="Tile intermediate Parquet to MVT XYZ tiles")
    tile_p.set_defaults(func=_help(tile_p))
    tile_sub = tile_p.add_subparsers(dest="tile_cmd", required=False)

    sal_tile = tile_sub.add_parser("sal", help="Tile SAL_2021 to MVT XYZ tiles")
    sal_tile.add_argument("--input", type=Path, default=SAL_PARQUET, help="Source parquet")
    sal_tile.add_argument(
        "--output",
        type=Path,
        default=TILES_DIR,
        help="Tile root directory; layer dir is appended (default: public/data/tiles)",
    )
    sal_tile.add_argument(
        "--layer-name",
        default="suburbs",
        help="MVT layer name (and on-disk subdirectory)",
    )
    sal_tile.add_argument("--min-zoom", type=int, default=6, help="Minimum zoom level")
    sal_tile.add_argument("--max-zoom", type=int, default=9, help="Maximum zoom level")
    sal_tile.set_defaults(func=cmd_tile_sal)

    iso_tile = tile_sub.add_parser(
        "isochrone",
        help="Tile one dissolved-isochrone duration into MVT XYZ tiles",
    )
    iso_tile.add_argument("--input", type=Path, default=ISO_FOOT_PARQUET, help="Source parquet")
    iso_tile.add_argument(
        "--output",
        type=Path,
        default=TILES_DIR,
        help="Tile root; layer dir iso_<mode>_<duration> is appended",
    )
    iso_tile.add_argument(
        "--duration", type=int, required=True, help="Contour to tile (e.g. 5 or 15)"
    )
    iso_tile.add_argument("--mode", default="foot", help="Travel mode (used in dir name)")
    iso_tile.add_argument("--min-zoom", type=int, default=9, help="Minimum zoom level")
    iso_tile.add_argument("--max-zoom", type=int, default=12, help="Maximum zoom level")
    iso_tile.set_defaults(func=cmd_tile_isochrone)

    ptv_lines_tile = tile_sub.add_parser("ptv-lines", help="Tile PTV line parquet to MVT XYZ tiles")
    ptv_lines_tile.add_argument("--mode", choices=PTV_MODES, default="metro_train", help="PTV mode")
    ptv_lines_tile.set_defaults(func=cmd_tile_ptv_lines)

    ptv_stops_tile = tile_sub.add_parser("ptv-stops", help="Tile PTV stop parquet to MVT XYZ tiles")
    ptv_stops_tile.add_argument("--mode", choices=PTV_MODES, default="metro_train", help="PTV mode")
    ptv_stops_tile.set_defaults(func=cmd_tile_ptv_stops)

    # `etl all`
    all_p = top_sub.add_parser(
        "all",
        help=(
            "Run the full pipeline end-to-end. Each step executes in its own "
            "subprocess so memory is reclaimed between steps — peak RSS is "
            "bounded to the worst single step rather than the cumulative sum."
        ),
    )
    all_p.add_argument(
        "--only",
        choices=("extract", "publish", "tile"),
        default=None,
        help="Limit to one phase (default: run all three).",
    )
    all_p.set_defaults(func=cmd_all)

    # `etl status`
    status_p = top_sub.add_parser("status", help="Show current state of pipeline artifacts")
    status_p.set_defaults(func=cmd_status)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    configure(verbose=getattr(args, "verbose", False))
    try:
        args.func(args)
    except FileNotFoundError as e:
        print(f"error: {e}", file=sys.stderr)
        sys.exit(1)
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
