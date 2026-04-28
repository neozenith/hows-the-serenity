"""argparse CLI for the ETL pipeline.

Follows .claude/rules/python/cli.md:
- argparse only (no click/typer)
- _help closure as the default for incomplete subcommand paths
- `set_defaults(func=...)` on every leaf
- `status` verb for read-only state inspection
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Callable
from pathlib import Path

from etl.config import (
    BOUNDARIES_ORIGINALS,
    CONVERTED_DIR,
    ISOCHRONE_DURATIONS,
    ISOCHRONES_ORIGINALS,
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
    publish_sal,
    tile_isochrone,
    tile_ptv,
    tile_sal,
)

# ---- Default file paths (single source of truth for CLI defaults) -----------

SAL_ZIP = BOUNDARIES_ORIGINALS / "SAL_2021_AUST_GDA2020_SHP.zip"
SAL_PARQUET = CONVERTED_DIR / "sal_2021_aust_gda2020.parquet"
SAL_GEOJSON = PUBLIC_DATA_DIR / "selected_sal_2021_aust_gda2020.geojson"
TILES_DIR = PUBLIC_DATA_DIR / "tiles"
SAL_TILES_DIR = TILES_DIR / "suburbs"
SUBURB_MAPPINGS_JSON = PUBLIC_DATA_DIR / "suburb_mappings.json"

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


def cmd_extract_rental_sales(args: argparse.Namespace) -> None:
    extract_rental_sales.run(
        input_dir=args.input,
        schema_file=args.schema,
        sal_parquet=args.sal_parquet,
        output_parquet=args.output_parquet,
        output_duckdb=args.output_duckdb,
    )


def cmd_publish_suburb_mappings(args: argparse.Namespace) -> None:
    build_suburb_mappings.build_suburb_mappings(
        sal_parquet=args.sal_parquet,
        rental_sales_duckdb=args.rental_sales_duckdb,
        output_path=args.output,
    )


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
