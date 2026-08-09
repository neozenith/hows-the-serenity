"""Tests for the multi-centre commute-hull compute step.

The step turns a radial scalar field (minutes-to-Southern-Cross, cached per
stop) into a per-mode network graph whose edge weights are point-to-point
travel times. These tests pin the two pieces of that translation that would
silently produce wrong hulls if they broke: edge-weight derivation and
Dijkstra distances from a non-Southern-Cross centre.
"""

from __future__ import annotations

import json
from pathlib import Path

import geopandas as gpd
import pandas as pd
import pytest
from shapely.geometry import LineString, Point

from etl.steps import compute_commute_hulls as cch

# A synthetic 4-stop line running due east, 0.01 deg (~1.1 km) apart, with
# cached minutes-to-SCS decreasing toward the west end (A is closest to SCS).
STOPS = [
    ("A Station", 144.90, -37.80, 10.0),
    ("B Station", 144.91, -37.80, 25.0),
    ("C Station", 144.92, -37.80, 40.0),
    ("D Station", 144.93, -37.80, 70.0),
]


def _write_fixtures(tmp_path: Path, mode: str = "TEST TRAIN") -> tuple[Path, Path, Path]:
    """Write stops parquet, lines parquet and a transit-time cache dir."""
    stops = gpd.GeoDataFrame(
        {
            "STOP_ID": [f"s{i}" for i in range(len(STOPS))],
            "STOP_NAME": [s[0] for s in STOPS],
            "MODE": [mode] * len(STOPS),
        },
        geometry=[Point(s[1], s[2]) for s in STOPS],
        crs="EPSG:4326",
    )
    stops_parquet = tmp_path / "stops.parquet"
    stops.to_parquet(stops_parquet)

    lines = gpd.GeoDataFrame(
        {"MODE": [mode]},
        geometry=[LineString([(s[1], s[2]) for s in STOPS])],
        crs="EPSG:4326",
    )
    lines_parquet = tmp_path / "lines.parquet"
    lines.to_parquet(lines_parquet)

    cache_dir = tmp_path / "transit_time_cache"
    cache_dir.mkdir()
    for name, _lon, _lat, minutes in STOPS:
        cch._cache_path(cache_dir, name).write_text(
            json.dumps({"transit_time_minutes": minutes}), encoding="utf-8"
        )
    return stops_parquet, lines_parquet, cache_dir


def test_cache_path_matches_upstream_slug_convention() -> None:
    """Filename slugging must match the upstream isochrones project exactly —
    a mismatch silently drops every stop for lack of a cached time.
    """
    p = cch._cache_path(Path("/cache"), "St Albans, O'Connor Station")
    assert p.name == "st_albans_oconnor_station_transit_time.json"


def test_load_stop_nodes_drops_stops_without_cached_times(tmp_path: Path) -> None:
    stops_parquet, _lines, cache_dir = _write_fixtures(tmp_path)
    cch._cache_path(cache_dir, "C Station").unlink()

    nodes = cch.load_stop_nodes(stops_parquet, cache_dir, "TEST TRAIN")

    assert sorted(nodes["name"]) == ["A Station", "B Station", "D Station"]


def test_load_stop_nodes_raises_on_unknown_mode(tmp_path: Path) -> None:
    """A typo'd mode label must fail loudly, not yield an empty hull set."""
    stops_parquet, _lines, cache_dir = _write_fixtures(tmp_path)

    with pytest.raises(ValueError, match="No stops found"):
        cch.load_stop_nodes(stops_parquet, cache_dir, "NOPE TRAIN")


def test_build_edges_derives_point_to_point_times_from_radial_scalars(
    tmp_path: Path,
) -> None:
    """Edge weight between adjacent stops is |t(A) - t(B)| — the telescoped
    travel time along the line. This is the core trick of the whole step.
    """
    stops_parquet, lines_parquet, cache_dir = _write_fixtures(tmp_path)
    nodes = cch.load_stop_nodes(stops_parquet, cache_dir, "TEST TRAIN")
    edges = cch.build_edges(lines_parquet, nodes, "TEST TRAIN")

    by_name = {n: i for i, n in enumerate(nodes["name"])}

    def weight(a: str, b: str) -> float:
        i, j = by_name[a], by_name[b]
        return edges[(i, j) if i < j else (j, i)]

    assert weight("A Station", "B Station") == pytest.approx(15.0)
    assert weight("B Station", "C Station") == pytest.approx(15.0)
    assert weight("C Station", "D Station") == pytest.approx(30.0)
    # Non-adjacent stops get no direct edge — the path must go through B.
    assert (by_name["A Station"], by_name["C Station"]) not in edges


def test_dijkstra_gives_distances_from_a_non_southern_cross_centre(
    tmp_path: Path,
) -> None:
    """Times from D (the far end) are the reverse cumulative sums — this is
    what lets hulls radiate from Geelong/Bendigo rather than only from SCS.
    """
    stops_parquet, lines_parquet, cache_dir = _write_fixtures(tmp_path)
    nodes = cch.load_stop_nodes(stops_parquet, cache_dir, "TEST TRAIN")
    edges = cch.build_edges(lines_parquet, nodes, "TEST TRAIN")
    by_name = {n: i for i, n in enumerate(nodes["name"])}

    times = cch.dijkstra(len(nodes), edges, by_name["D Station"])

    assert times[by_name["D Station"]] == pytest.approx(0.0)
    assert times[by_name["C Station"]] == pytest.approx(30.0)
    assert times[by_name["B Station"]] == pytest.approx(45.0)
    assert times[by_name["A Station"]] == pytest.approx(60.0)


def test_add_transfer_edges_joins_colocated_platforms() -> None:
    """Alternate names for one station ("X Station" / "X Railway Station")
    sit metres apart and must cost nothing to walk between.
    """
    nodes = pd.DataFrame(
        [
            {"name": "X Station", "minutes": 20.0, "x": 144.9, "y": -37.8},
            {"name": "X Railway Station", "minutes": 21.0, "x": 144.9001, "y": -37.8},
            {"name": "Far Station", "minutes": 50.0, "x": 145.5, "y": -37.8},
        ]
    )
    edges = cch.add_transfer_edges(nodes, {})

    assert edges[(0, 1)] == 0.0
    assert (0, 2) not in edges
    assert (1, 2) not in edges


def test_run_skips_centres_the_network_cannot_reach(tmp_path: Path) -> None:
    """The tram network doesn't exist in Shepparton — an unreachable centre
    is skipped with a log line, never a crash or an empty polygon.
    """
    stops_parquet, lines_parquet, cache_dir = _write_fixtures(tmp_path)
    out = tmp_path / "hulls.geojson"

    n = cch.run(
        stops_parquet=stops_parquet,
        lines_parquet=lines_parquet,
        cache_dir=cache_dir,
        mode_label="TEST TRAIN",
        centres=[
            cch.Centre("on-net", "On Network", 144.90, -37.80, False),
            cch.Centre("off-net", "Off Network", 149.00, -35.00, False),
        ],
        tiers=(15, 30, 45, 60),
        output_geojson=out,
    )

    assert n == 4  # one centre x four tiers
    gdf = gpd.read_file(out)
    assert set(gdf["centre"]) == {"on-net"}
    assert sorted(gdf["transit_time_minutes_nearest_tier"]) == [15.0, 30.0, 45.0, 60.0]
    assert gdf.geometry.is_valid.all()


def test_run_southern_cross_centre_uses_cached_times_directly(tmp_path: Path) -> None:
    """direct_times=True means the hull membership is the cached scalars, not
    graph distances — primary measurement beats derived. Stop A has t=10, so
    only A falls inside the 15-min tier.
    """
    stops_parquet, lines_parquet, cache_dir = _write_fixtures(tmp_path)
    out = tmp_path / "hulls.geojson"

    cch.run(
        stops_parquet=stops_parquet,
        lines_parquet=lines_parquet,
        cache_dir=cache_dir,
        mode_label="TEST TRAIN",
        centres=[cch.Centre("scs", "Southern Cross", 144.90, -37.80, True)],
        tiers=(15, 30, 45, 60),
        output_geojson=out,
    )

    gdf = gpd.read_file(out).set_index("transit_time_minutes_nearest_tier")
    assert gdf.loc[15.0, "point_count"] == 1  # A only (t=10)
    assert gdf.loc[30.0, "point_count"] == 2  # A + B (t=25)
    assert gdf.loc[45.0, "point_count"] == 3  # A + B + C (t=40)
    assert gdf.loc[60.0, "point_count"] == 3  # D is 70 min — still outside


def test_replacement_bus_shapes_do_not_create_adjacency(tmp_path: Path) -> None:
    """Rail-replacement buses are tagged with the rail mode but run on roads.

    Here a "bus" shape links A directly to D, skipping B and C. Left in, that
    invents an A-D adjacency the railway has no equivalent for, and its weight
    (|10 - 70| = 60 min) would let the time field leap across the network.
    """
    stops_parquet, lines_parquet, cache_dir = _write_fixtures(tmp_path)

    rail = gpd.read_parquet(lines_parquet)
    rail["SHORT_NAME"] = ["Rail"]
    bus = gpd.GeoDataFrame(
        {"MODE": ["TEST TRAIN"], "SHORT_NAME": ["Replacement Bus"]},
        # A detour that touches only the first and last stop.
        geometry=[LineString([(144.90, -37.80), (144.905, -37.85), (144.93, -37.80)])],
        crs="EPSG:4326",
    )
    gpd.GeoDataFrame(pd.concat([rail, bus], ignore_index=True), crs="EPSG:4326").to_parquet(
        lines_parquet
    )

    nodes = cch.load_stop_nodes(stops_parquet, cache_dir, "TEST TRAIN")
    by_name = {n: i for i, n in enumerate(nodes["name"])}
    a, d = by_name["A Station"], by_name["D Station"]

    unfiltered = cch.build_edges(lines_parquet, nodes, "TEST TRAIN")
    assert (min(a, d), max(a, d)) in unfiltered, "fixture should reproduce the bogus edge"

    filtered = cch.build_edges(lines_parquet, nodes, "TEST TRAIN", r"replacement\s*bus")
    assert (min(a, d), max(a, d)) not in filtered
    # The genuine rail adjacency survives.
    assert (min(a, by_name["B Station"]), max(a, by_name["B Station"])) in filtered


def test_non_station_stops_are_excluded_from_the_graph(tmp_path: Path) -> None:
    """Wayfinding markers and kerbside replacement stops are not stations.

    They carry the rail MODE and pick up cached times, so without filtering
    they become graph nodes and yield edges implying a few km/h.
    """
    stops_parquet, _lines, cache_dir = _write_fixtures(tmp_path)

    stops = gpd.read_parquet(stops_parquet)
    junk = gpd.GeoDataFrame(
        {
            "STOP_ID": ["j1", "j2"],
            "STOP_NAME": ["Decision Point 3", "A Rail Replacement Bus Stop"],
            "MODE": ["TEST TRAIN", "TEST TRAIN"],
        },
        geometry=[Point(144.905, -37.80), Point(144.9051, -37.80)],
        crs="EPSG:4326",
    )
    gpd.GeoDataFrame(pd.concat([stops, junk], ignore_index=True), crs="EPSG:4326").to_parquet(
        stops_parquet
    )
    for name in ("Decision Point 3", "A Rail Replacement Bus Stop"):
        cch._cache_path(cache_dir, name).write_text(
            json.dumps({"transit_time_minutes": 99.0}), encoding="utf-8"
        )

    kept = cch.load_stop_nodes(
        stops_parquet,
        cache_dir,
        "TEST TRAIN",
        exclude_stop_pattern=r"rail\s*replacement|decision\s*point",
    )
    assert sorted(kept["name"]) == ["A Station", "B Station", "C Station", "D Station"]


def test_run_raises_when_no_centre_is_reachable(tmp_path: Path) -> None:
    """Producing zero hulls means the config is wrong; fail loudly rather
    than writing an empty layer the frontend would render as nothing.
    """
    stops_parquet, lines_parquet, cache_dir = _write_fixtures(tmp_path)

    with pytest.raises(ValueError, match="No hull features produced"):
        cch.run(
            stops_parquet=stops_parquet,
            lines_parquet=lines_parquet,
            cache_dir=cache_dir,
            mode_label="TEST TRAIN",
            centres=[cch.Centre("off-net", "Off Network", 149.0, -35.0, False)],
            tiers=(15, 30, 45, 60),
            output_geojson=tmp_path / "hulls.geojson",
        )
