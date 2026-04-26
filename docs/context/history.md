# Project History & Prior-Art Map

This document seeds context for coding sessions on `hows-the-serenity`. It records what came before, where the source artifacts live, and which pieces of the predecessor we want to keep, replace, or improve.

## Predecessor: the VanillaJS isochrones webapp

The current project is a **rewrite** of a single-page VanillaJS site that visualises Melbourne rental affordability against public-transport accessibility. The original is intact and runnable at:

| Concern | Path |
|---|---|
| Predecessor site root | `/Users/joshpeak/play/isochrones/sites/webapp/` |
| Main HTML shell | `/Users/joshpeak/play/isochrones/sites/webapp/index.html` |
| All app logic (~1800 lines) | `/Users/joshpeak/play/isochrones/sites/webapp/scripts.js` |
| Layer config (declarative) | `/Users/joshpeak/play/isochrones/sites/webapp/layers_config.json` |
| Suburb→SA2 mappings | `/Users/joshpeak/play/isochrones/sites/webapp/geospatial_mappings.js` |
| DuckDB SQL templates | `/Users/joshpeak/play/isochrones/sites/webapp/sql/` (`lga_template.sql`, `sa2_template.sql`, `postcode_template.sql`) |
| Local-serve Makefile | `/Users/joshpeak/play/isochrones/sites/webapp/Makefile` (`uv run -m http.server`) |

### What it does (today)

- Renders a Deck.GL canvas over a CartoDB dark base map with **12 toggleable layers** of Victoria-only data: 5/15-min walking isochrones, train/tram lines & stops, commute-time hulls, LGA/SAL/postcode boundaries, and real-estate candidate dots.
- Loads a **client-side DuckDB-WASM** instance and attaches `data/rental_sales.duckdb` so click-handlers can pull rental and sales time-series for any selected LGA or SAL.
- Renders **Plotly time-series charts** when 1 or 2 boundaries are selected (single-pane or side-by-side comparison; supports a Rental ↔ Sales toggle).
- Has a **GPS "Show My Location"** affordance (`navigator.geolocation` → `ScatterplotLayer`).

### CDN libraries baked into the original `index.html`

```text
deck.gl@latest           https://unpkg.com/deck.gl@latest/dist.min.js
maplibre-gl@3.0.0        https://unpkg.com/maplibre-gl@3.0.0/...
plotly-latest            https://cdn.plot.ly/plotly-latest.min.js
@duckdb/duckdb-wasm      https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@latest/+esm
```

The rewrite swaps every CDN import for a Vite-bundled, version-pinned npm dependency.

## Upstream data pipeline

The visualisation is the *thin glass* on top of a substantial Python pipeline:

| Concern | Path |
|---|---|
| Pipeline root | `/Users/joshpeak/play/isochrones/` |
| Orchestration | `/Users/joshpeak/play/isochrones/Makefile` |
| Helper scripts | `/Users/joshpeak/play/isochrones/scripts/*.py` |
| Script index (curated) | `/Users/joshpeak/play/isochrones/scripts/INDEX.md` |
| Rental-sales ETL → DuckDB | `/Users/joshpeak/play/isochrones/scripts/rental_sales/extract.py` |

### Pipeline DAG (high level)

```
Raw shapefiles (ABS / PTV / VicData)
      │
      ▼
export_shapefiles.py              → GeoJSON / GeoParquet (WGS84)
      │
      ▼
extract_state_polygons.py         → Victoria-only mask
extract_boundaries_by_state.py    → LGA / SAL / SA2 subsets for VIC
extract_postcode_polygons.py      → postcodes that intersect transport
extract_stops_within_union.py     → ~445 train+tram stops
      │
      ▼
batch_isochrones_for_stops.py     → per-stop GraphHopper isochrones (cached)
fix_geojson.py                    → normalise mixed source shapes
consolidate_isochrones.py         → 5/15-min unioned polygons
      │
      ▼
stops_by_transit_time.py          → Google Maps directions → commute-time hulls
geocode_candidates.py             → real-estate listing → walkability annotation
      │
      ▼
rental_sales/extract.py           → all_extracted_data.duckdb
```

The pipeline copies its outputs into `sites/webapp/data/` (see the `site_data` Make target). The current rewrite has a **wholesale copy** of those files at `data/` in this repo — they are static inputs from the pipeline's perspective.

## Critical assets in this repo (`data/`)

All paths relative to the project root:

| File | Size | Origin | Purpose |
|---|---:|---|---|
| `5.geojson` | 1.7 MB | `consolidate_isochrones.py` | 5-min walking isochrones (union) |
| `15.geojson` | 6.9 MB | `consolidate_isochrones.py` | 15-min walking isochrones (union) |
| `all_candidates.geojson` | 3 KB | `geocode_candidates.py` | Real-estate property points |
| `lines_within_union_metro_train.geojson` | 43 MB | `extract_stops_within_union.py` | Train route geometry |
| `lines_within_union_metro_tram.geojson` | 5.7 MB | `extract_stops_within_union.py` | Tram route geometry |
| `ptv_commute_tier_hulls_metro_train.geojson` | 3 KB | `stops_by_transit_time.py` | Train commute-time hulls |
| `ptv_commute_tier_hulls_metro_tram.geojson` | 3 KB | `stops_by_transit_time.py` | Tram commute-time hulls |
| `selected_lga_2024_aust_gda2020.geojson` | 3.5 MB | `extract_boundaries_by_state.py` | VIC LGA boundaries (ABS 2024) |
| `selected_postcodes_with_trams_trains.geojson` | 1.7 MB | `extract_postcode_polygons.py` | Postcodes touching transport |
| `selected_sa2_2021_aust_gda2020.geojson` | 3.8 MB | `extract_boundaries_by_state.py` | VIC SA2 boundaries (ABS 2021) |
| `selected_sal_2021_aust_gda2020.geojson` | 3.7 MB | `extract_boundaries_by_state.py` | VIC suburb (SAL) boundaries (ABS 2021) |
| `stops_with_commute_times_metro_train.geojson` | 91 KB | `stops_by_transit_time.py` | Train stops + transit time to Southern Cross |
| `stops_with_commute_times_metro_tram.geojson` | 304 KB | `stops_by_transit_time.py` | Tram stops + transit time to Southern Cross |
| `rental_sales.duckdb` | 3.8 MB | `rental_sales/extract.py` | Rental + sales time-series (ABS-aggregated) |

### `rental_sales.duckdb` schema (as used by the predecessor)

The original `scripts.js` queries the table `rental_sales.rental_sales` with these columns:

- `time_bucket` (timestamp; year/quarter buckets)
- `dwelling_type` (`house`, `unit`, etc.)
- `bedrooms` (string; `'all'` is a "rolled-up" series)
- `statistic` (filtered to `'median'`)
- `value` (numeric)
- `geospatial_type` (`'lga'`, `'suburb'`)
- `geospatial_codes` (hyphen-delimited list; matched with `list_contains(string_split(...), '-')`)
- `data_type` (`'rental'`, `'sales'`)

Templated SQL in `sites/webapp/sql/*.sql` uses `{{lga_name}}` / `{{suburb_name}}` / `{{postcode}}` placeholders — the predecessor inlines these as string interpolation; the rewrite should parameterise them properly.

## What we're keeping vs. improving

### Keep (the prior art is correct)

- **Layer taxonomy** in `layers_config.json` — 12 layers, declarative, reasonably normalised. Worth porting verbatim as a typed config.
- **Slug taxonomy** for selection IDs (`type-property` pattern in `getItemId`) — survives the rewrite cleanly.
- **DuckDB-WASM as the in-browser query engine** — the right tool; no server-side dependency, all data ships in the static bundle.
- **MapLibre + CartoDB dark-matter** as the base map — matches the data-dense aesthetic.
- **GeoJSON-as-source-of-truth** for boundaries — the pipeline already produces clean WGS84 outputs.

### Improve

- **Replace CDN script tags with bundled npm deps** — version-pinned, tree-shaken, reproducible.
- **TypeScript everywhere** — the original `scripts.js` has zero static guarantees about layer-config shape, DuckDB row shape, or selection state.
- **Decompose the 1800-line monolith** into React components: `MapCanvas`, `LayerPanel`, `SelectionPanel`, `ChartPanel`, `LocationButton`, `DuckDBProvider`.
- **Validate DuckDB rows with Zod** at the trust boundary so chart code can rely on typed data.
- **Parameterise SQL templates** — the predecessor inlines user-derived strings into queries (`'${geospatialId}'`); a Zod-validated allowlist + parameterised statements is safer.
- **Lift selection state out of a global `Map`** into a single React context or store; the original has implicit ordering coupling between `selectedItems` insertion and "oldest selection wins" eviction.
- **Replace Plotly** with a leaner React-native chart lib (e.g. Recharts, Visx, or a tiny custom SVG) — Plotly is ~3 MB minified for what amounts to two line charts.
- **GitHub Pages deploy** via Vite's `base` + `actions/deploy-pages` instead of `python -m http.server`.

### Open questions

- Do we still need SA2 boundaries? The predecessor loads them but `layers_config.json` only references SAL. Investigate before porting.
- Is the 43 MB `lines_within_union_metro_train.geojson` over-detailed? Worth re-tiling at lower zoom for a smaller payload.
- The predecessor uses `<latest>` CDN tags — pin to known-good versions when porting (e.g. deck.gl 9.x, MapLibre 4.x).

## Working directory & data serving

- **Static asset serving**: GeoJSON + DuckDB files live under `data/` at the project root (outside `src/` and outside `public/`). Vite only serves `public/` by default, so a symlink `public/data → ../data` exposes them at the dev URL `/data/<file>`.
- **Bun + Vite**: project is set up per the project-level `CLAUDE.md` — runtime is `bun`, never `npm`/`yarn`/`pnpm`. All make targets go through `bun`.
