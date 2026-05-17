"""Tests for the school-zones extract step."""

from __future__ import annotations

import json
from pathlib import Path

import geopandas as gpd

from etl.steps import extract_school_zones as ez


def _mini_geojson(path: Path, props: dict[str, object]) -> None:
    """Write a tiny 1-feature WGS84 polygon GeoJSON so the test runs in ms
    without bringing in the 22MB DataVic dataset.
    """
    feat = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": props,
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [
                        [
                            [144.95, -37.81],
                            [144.96, -37.81],
                            [144.96, -37.82],
                            [144.95, -37.82],
                            [144.95, -37.81],
                        ]
                    ],
                },
            }
        ],
    }
    path.write_text(json.dumps(feat), encoding="utf-8")


def test_parse_level_handles_primary_secondary_and_standalone_filenames() -> None:
    """The level slug feeds tile directory naming + frontend layer keys —
    must be stable across the three source-naming styles DataVic ships.
    """
    assert ez.parse_level("Primary_Integrated_2026") == "primary"
    assert ez.parse_level("Secondary_Integrated_Year7_2026") == "secondary_year7"
    assert ez.parse_level("Secondary_Integrated_Year12_2026") == "secondary_year12"
    assert ez.parse_level("Standalone_juniorsec_2026") == "standalone_juniorsec"
    assert ez.parse_level("Standalone_singlesex_2026") == "standalone_singlesex"


def test_run_concatenates_geojsons_and_derives_level_column(tmp_path: Path) -> None:
    """One Primary + one Secondary_Year7 input produce a 2-feature parquet
    with a `level` column the tile step can group on.
    """
    src = tmp_path / "schools"
    src.mkdir()
    _mini_geojson(
        src / "Primary_Integrated_2026.geojson",
        {"School_Name": "Lockwood PS", "Year_Level": "P6"},
    )
    _mini_geojson(
        src / "Secondary_Integrated_Year7_2026.geojson",
        {"School_Name": "Lockwood SC", "Year_Level": "Y7"},
    )

    out = tmp_path / "school_zones.parquet"
    n = ez.run(source_dir=src, output_parquet=out)

    assert n == 2
    assert out.exists()
    round_trip = gpd.read_parquet(out)
    levels = sorted(round_trip["level"].unique().tolist())
    assert levels == ["primary", "secondary_year7"]
    assert "School_Name" in round_trip.columns
    assert round_trip.crs is not None
