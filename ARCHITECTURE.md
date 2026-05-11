# Architecture

A single-page Vite + React 19 + TypeScript map app that visualises Melbourne
suburb rentals/sales over a multi-layer transit map. Rendering is GPU-driven
via deck.gl; the analytical store is a 3.5 MB DuckDB file pulled directly into
the browser via DuckDB-WASM. Data is produced by a Python ETL pipeline and
published as static assets that GitHub Pages serves verbatim — there is no
backend.

This document examines the system through five **architectural lenses**. Each
lens has a simplified overview (always visible) and a detailed reference
(collapsed). Both fences are live Mermaid; GitHub renders them inline.

- [1. Module architecture](#1-module-architecture) — what the frontend modules are and how they connect
- [2. Data flow](#2-data-flow) — how raw data becomes tiles + DuckDB + GeoJSON
- [3. Deployment](#3-deployment) — CI, artifacts, and Pages publication
- [4. Boot sequence](#4-boot-sequence) — what happens when the user loads the page
- [5. Suburb-click sequence](#5-suburb-click-sequence) — what happens when the user clicks a suburb

---

## 1. Module architecture

Frontend module layout after the recent refactor: `App.tsx` is now pure
orchestration, with state distributed across five custom hooks and the deck.gl
layer pipeline expressed as a typed catalogue rather than inline construction.

```mermaid
flowchart LR
    user["Browser tab"]:::ingressPrimary
    app["App.tsx<br/>orchestration"]:::computePrimary
    hooks["5 custom hooks<br/>state + lifecycle"]:::computePrimary
    layers["Layer catalogue<br/>buildLayers"]:::computeSecondary
    deck["DeckGL + MVTLayer<br/>+ GeoJsonLayer"]:::computePrimary
    plot["Plot panel<br/>lazy chunk"]:::computeSecondary
    duckdb[("DuckDB-WASM<br/>rental_sales.duckdb")]:::dataPrimary
    tiles[("MVT tile trees<br/>+ manifests")]:::dataPrimary
    basemap[("CartoCDN<br/>dark-matter style")]:::infraSecondary

    user --> app
    app --> hooks
    app --> layers
    layers --> deck
    app --> plot
    deck --> tiles
    deck --> basemap
    plot --> duckdb
    hooks --> duckdb

    classDef ingressPrimary    fill:#1d4ed8,stroke:#bfdbfe,color:#ffffff,stroke-width:2px
    classDef computePrimary    fill:#6d28d9,stroke:#ddd6fe,color:#ffffff,stroke-width:2px
    classDef computeSecondary  fill:#ddd6fe,stroke:#5b21b6,color:#1e293b,stroke-width:1px
    classDef dataPrimary       fill:#0f766e,stroke:#99f6e4,color:#ffffff,stroke-width:2px
    classDef infraSecondary    fill:#cbd5e1,stroke:#64748b,color:#1e293b,stroke-width:1px
```

*Caption: top-level surfaces. The browser owns DuckDB and the tile pipeline directly — there is no server process.*

<details>
<summary>Detailed module map (28 nodes)</summary>

```mermaid
flowchart LR
    subgraph entry["Entry"]
        main["main.tsx"]:::ingressPrimary
        provider["ThemeProvider"]:::ingressSecondary
        app["App.tsx"]:::ingressPrimary
    end

    subgraph hooks["Custom hooks"]
        useDb["useDuckDb"]:::computePrimary
        useMan["useTileManifests"]:::computePrimary
        useMap["useSuburbMappings"]:::computeSecondary
        useVis["useLayerVisibility"]:::computeSecondary
        useSel["useRegionSelection"]:::computePrimary
    end

    subgraph libs["lib/"]
        layers["layers.ts<br/>SPECS + factories"]:::computePrimary
        duck["duckdb.ts"]:::dataSecondary
        manifest["tile-manifest.ts"]:::dataSecondary
        rentq["rental-sales-query.ts"]:::dataSecondary
        mappings["suburb-mappings.ts"]:::dataSecondary
        tstats["tile-stats.ts"]:::infraSecondary
        fstats["frame-stats.ts"]:::infraSecondary
        thooks["test-hooks.ts"]:::infraSecondary
    end

    subgraph comps["Components"]
        panel["ControlPanel"]:::ingressSecondary
        spp["SuburbPlotPanel"]:::ingressSecondary
        sp["SuburbPlot<br/>lazy chunk"]:::computeSecondary
        tmo["TileMemoryOverlay"]:::infraSecondary
        eb["ErrorBoundary"]:::infraSecondary
    end

    subgraph ext["External"]
        deck["deck.gl"]:::computePrimary
        ml["MapLibre"]:::infraSecondary
        plotly["Plotly"]:::computeSecondary
        wasm[("DuckDB-WASM")]:::dataPrimary
    end

    main --> provider --> app
    app --> useDb --> duck --> wasm
    app --> useMan --> manifest
    app --> useMap --> mappings
    app --> useVis
    app --> useSel --> thooks
    app --> layers --> deck
    deck --> ml
    deck --> tstats
    app --> panel
    app --> spp --> eb --> sp
    sp --> plotly
    sp --> rentq --> wasm
    sp --> mappings
    tmo --> tstats
    tmo --> fstats
    layers --> manifest

    classDef ingressPrimary    fill:#1d4ed8,stroke:#bfdbfe,color:#ffffff,stroke-width:2px
    classDef ingressSecondary  fill:#bfdbfe,stroke:#1e40af,color:#1e293b,stroke-width:1px
    classDef computePrimary    fill:#6d28d9,stroke:#ddd6fe,color:#ffffff,stroke-width:2px
    classDef computeSecondary  fill:#ddd6fe,stroke:#5b21b6,color:#1e293b,stroke-width:1px
    classDef dataPrimary       fill:#0f766e,stroke:#99f6e4,color:#ffffff,stroke-width:2px
    classDef dataSecondary     fill:#ccfbf1,stroke:#0f766e,color:#1e293b,stroke-width:1px
    classDef infraSecondary    fill:#cbd5e1,stroke:#64748b,color:#1e293b,stroke-width:1px

    classDef sgBlue    fill:#dbeafe,stroke:#3b82f6,color:#1e293b
    classDef sgViolet  fill:#ede9fe,stroke:#8b5cf6,color:#1e293b
    classDef sgTeal    fill:#ccfbf1,stroke:#0f766e,color:#1e293b
    classDef sgSlate   fill:#f1f5f9,stroke:#334155,color:#334155

    class entry sgBlue
    class hooks sgViolet
    class libs sgTeal
    class comps sgBlue
    class ext sgSlate
```

</details>

---

## 2. Data flow

The ETL is a Python `argparse` CLI under `etl/` with three command groups —
`extract` (raw → Parquet), `publish` (Parquet → GeoJSON/JSON in `public/data/`),
and `tile` (Parquet → MVT XYZ tile tree + `manifest.json`). Every output lands
under `public/data/`, which Vite copies verbatim into the deployed bundle. The
browser then consumes `.duckdb` via WASM, MVT tiles via deck.gl's `MVTLayer`,
and static GeoJSON via `GeoJsonLayer`.

```mermaid
flowchart LR
    sources["External sources<br/>ABS / PTV / rentals"]:::sourcePrimary
    etl["ETL Python CLI<br/>extract / publish / tile"]:::transformPrimary
    interim[("data/converted/<br/>*.parquet")]:::sourceSecondary
    pubdata[("public/data/<br/>duckdb + geojson + tiles")]:::loadPrimary
    browser["Browser runtime<br/>DuckDB-WASM + deck.gl"]:::orchPrimary

    sources --> etl
    etl --> interim
    interim --> etl
    etl --> pubdata
    pubdata --> browser

    classDef sourcePrimary     fill:#b45309,stroke:#fde68a,color:#ffffff,stroke-width:2px
    classDef sourceSecondary   fill:#fef3c7,stroke:#92400e,color:#1e293b,stroke-width:1px
    classDef transformPrimary  fill:#c2410c,stroke:#fed7aa,color:#ffffff,stroke-width:2px
    classDef loadPrimary       fill:#047857,stroke:#a7f3d0,color:#ffffff,stroke-width:2px
    classDef orchPrimary       fill:#4338ca,stroke:#c7d2fe,color:#ffffff,stroke-width:2px
```

*Caption: extract → intermediate Parquet → publish/tile → public/data → browser. The intermediate Parquet is a re-entrant cache — re-running publish/tile does not refetch sources.*

<details>
<summary>Detailed data flow (24 nodes)</summary>

```mermaid
flowchart LR
    subgraph srcs["data/originals (raw)"]
        absS["ABS SAL+LGA<br/>shapefiles"]:::sourcePrimary
        ptvS["PTV lines+stops<br/>+ commute hulls"]:::sourcePrimary
        isoS["Isochrones<br/>foot 5/15min"]:::sourcePrimary
        rentS["Rental/sales<br/>raw input"]:::sourcePrimary
    end

    subgraph etlP["etl/ Python CLI"]
        ext["extract<br/>shapefile + geojson<br/>parsing"]:::transformPrimary
        pub["publish<br/>simplify + filter"]:::transformPrimary
        tile["tile<br/>MVT XYZ encoder"]:::transformPrimary
    end

    subgraph mid["data/converted/"]
        salP[("sal.parquet")]:::sourceSecondary
        lgaP[("lga.parquet")]:::sourceSecondary
        ptvP[("ptv_lines + stops<br/>parquet")]:::sourceSecondary
        isoP[("iso_foot.parquet")]:::sourceSecondary
        rsP[("rental_sales<br/>parquet")]:::sourceSecondary
    end

    subgraph pub2["public/data/"]
        duckF[("rental_sales<br/>.duckdb")]:::loadPrimary
        lgaG[("lga geojson")]:::loadPrimary
        hullsG[("commute hulls<br/>geojson x2")]:::loadPrimary
        sumJ[("suburb_mappings<br/>.json")]:::loadPrimary
        tilesD[("tiles/ tree<br/>9 layers + manifest")]:::loadPrimary
    end

    subgraph fe["Browser runtime"]
        wasm[("DuckDB-WASM")]:::orchPrimary
        mvt["MVTLayer x9"]:::orchPrimary
        gj["GeoJsonLayer x3"]:::orchSecondary
    end

    absS --> ext --> salP --> pub
    absS --> ext --> lgaP --> pub
    ptvS --> ext --> ptvP --> tile
    isoS --> ext --> isoP --> tile
    rentS --> ext --> rsP --> pub
    salP --> tile

    pub --> lgaG
    pub --> hullsG
    pub --> sumJ
    pub --> duckF
    tile --> tilesD

    duckF --> wasm
    tilesD --> mvt
    lgaG --> gj
    hullsG --> gj
    sumJ --> wasm

    classDef sourcePrimary     fill:#b45309,stroke:#fde68a,color:#ffffff,stroke-width:2px
    classDef sourceSecondary   fill:#fef3c7,stroke:#92400e,color:#1e293b,stroke-width:1px
    classDef transformPrimary  fill:#c2410c,stroke:#fed7aa,color:#ffffff,stroke-width:2px
    classDef loadPrimary       fill:#047857,stroke:#a7f3d0,color:#ffffff,stroke-width:2px
    classDef orchPrimary       fill:#4338ca,stroke:#c7d2fe,color:#ffffff,stroke-width:2px
    classDef orchSecondary     fill:#e0e7ff,stroke:#3730a3,color:#1e293b,stroke-width:1px

    classDef sgAmber  fill:#fef3c7,stroke:#92400e,color:#1e293b
    classDef sgOrange fill:#fff7ed,stroke:#9a3412,color:#1e293b
    classDef sgGreen  fill:#d1fae5,stroke:#065f46,color:#1e293b
    classDef sgIndigo fill:#e0e7ff,stroke:#3730a3,color:#1e293b

    class srcs sgAmber
    class etlP sgOrange
    class mid sgAmber
    class pub2 sgGreen
    class fe sgIndigo
```

</details>

---

## 3. Deployment

Two-job GitHub Actions workflow, artifact-based — no `gh-pages` branch. Every
run produces a 30-day workflow artifact. Push-to-`main` chains a Pages deploy
that re-builds with the dynamically-discovered base path. Tag pushes also
zip-and-upload to a GitHub Release.

```mermaid
flowchart LR
    dev["Developer<br/>push or tag"]:::ingressPrimary
    ci["build job<br/>audit + lint + test"]:::computePrimary
    bundle[("dist/ bundle")]:::dataPrimary
    art["Workflow artifact<br/>30-day retention"]:::dataSecondary
    pages["deploy-pages job<br/>main only"]:::computePrimary
    rel[("Release asset<br/>tag only")]:::dataSecondary
    site["Live Pages site"]:::ingressPrimary

    dev --> ci --> bundle
    bundle --> art
    bundle --> pages --> site
    bundle --> rel

    classDef ingressPrimary    fill:#1d4ed8,stroke:#bfdbfe,color:#ffffff,stroke-width:2px
    classDef computePrimary    fill:#6d28d9,stroke:#ddd6fe,color:#ffffff,stroke-width:2px
    classDef dataPrimary       fill:#0f766e,stroke:#99f6e4,color:#ffffff,stroke-width:2px
    classDef dataSecondary     fill:#ccfbf1,stroke:#0f766e,color:#1e293b,stroke-width:1px
```

*Caption: build always runs; Pages and Release fire conditionally on the ref.*

<details>
<summary>Detailed CI pipeline (24 nodes)</summary>

```mermaid
flowchart LR
    subgraph trig["Triggers"]
        push["push main"]:::ingressPrimary
        pr["pull_request"]:::ingressSecondary
        tag["tag v*"]:::ingressPrimary
        wd["workflow_dispatch"]:::ingressSecondary
    end

    subgraph build["build job (always)"]
        setup["bun + uv setup"]:::computeSecondary
        deps["frozen-lockfile<br/>install"]:::computeSecondary
        audit["bun audit<br/>high+ severity"]:::computePrimary
        lint["biome ci<br/>+ ruff"]:::computePrimary
        types["tsc -b + mypy"]:::computePrimary
        unit["vitest + pytest"]:::computePrimary
        e2e["playwright<br/>2 specs"]:::computePrimary
        viteB["vite build"]:::computePrimary
    end

    subgraph outs["Outputs"]
        dist[("dist/")]:::dataPrimary
        siteA["site-dist artifact<br/>30 day"]:::dataSecondary
        e2eA["e2e-failures<br/>14 day on fail"]:::dataSecondary
        zipR[("Release asset<br/>tag only")]:::dataSecondary
    end

    subgraph deploy["deploy-pages job"]
        cfg["configure-pages<br/>resolves base_path"]:::computeSecondary
        rebuild["vite build<br/>PAGES_BASE_PATH"]:::computePrimary
        upload["upload-pages-artifact"]:::computeSecondary
        deployA["deploy-pages action"]:::computePrimary
        live["Live site"]:::ingressPrimary
    end

    push --> build
    pr --> build
    tag --> build
    wd --> build

    setup --> deps --> audit --> lint --> types --> unit --> viteB --> e2e
    viteB --> dist
    dist --> siteA
    e2e -.-> e2eA
    tag -.-> zipR
    dist -.-> zipR

    push --> cfg --> rebuild --> upload --> deployA --> live

    classDef ingressPrimary    fill:#1d4ed8,stroke:#bfdbfe,color:#ffffff,stroke-width:2px
    classDef ingressSecondary  fill:#bfdbfe,stroke:#1e40af,color:#1e293b,stroke-width:1px
    classDef computePrimary    fill:#6d28d9,stroke:#ddd6fe,color:#ffffff,stroke-width:2px
    classDef computeSecondary  fill:#ddd6fe,stroke:#5b21b6,color:#1e293b,stroke-width:1px
    classDef dataPrimary       fill:#0f766e,stroke:#99f6e4,color:#ffffff,stroke-width:2px
    classDef dataSecondary     fill:#ccfbf1,stroke:#0f766e,color:#1e293b,stroke-width:1px

    classDef sgBlue    fill:#dbeafe,stroke:#3b82f6,color:#1e293b
    classDef sgViolet  fill:#ede9fe,stroke:#8b5cf6,color:#1e293b
    classDef sgTeal    fill:#ccfbf1,stroke:#0f766e,color:#1e293b

    class trig sgBlue
    class build sgViolet
    class outs sgTeal
    class deploy sgViolet
```

</details>

---

## 4. Boot sequence

What happens between page-load and first paint. The five custom hooks fire in
parallel from `App.tsx`'s render — each owns one async pipeline. Layers are
gated on their per-layer manifest, so `MVTLayer`s render incrementally as their
manifests resolve.

```mermaid
sequenceDiagram
    actor U as User
    participant B as Browser
    participant A as App.tsx
    participant H as 5 hooks
    participant CDN as Pages CDN
    participant D as DuckDB-WASM

    U->>B: visit page
    B->>A: render
    A->>H: mount hooks (parallel)
    par DuckDB
        H->>CDN: GET rental_sales.duckdb
        CDN-->>D: bytes
        D-->>H: tables ready
    and Manifests
        H->>CDN: GET manifest.json x9
        CDN-->>H: per-layer extents
    and Mappings
        H->>CDN: GET suburb_mappings.json
        CDN-->>H: SAL groups
    end
    H-->>A: state updates
    A->>B: useMemo rebuilds layers
    B-->>U: rendered map
```

*Caption: three independent async pipelines fan out from one render. Layers paint as their manifests arrive — no all-or-nothing waterfall.*

<details>
<summary>Detailed boot sequence with tile fetches</summary>

```mermaid
sequenceDiagram
    actor U as User
    participant B as Browser
    participant M as main.tsx
    participant TP as ThemeProvider
    participant A as App.tsx
    participant UD as useDuckDb
    participant UM as useTileManifests
    participant US as useSuburbMappings
    participant UV as useLayerVisibility
    participant UR as useRegionSelection
    participant LIB as duckdb.ts singleton
    participant CDN as Pages CDN
    participant D as DuckDB-WASM
    participant DG as DeckGL
    participant MVT as MVTLayer

    U->>B: navigate
    B->>M: load main.tsx
    M->>TP: wrap App
    TP->>A: render
    A->>UD: mount
    A->>UM: mount
    A->>US: mount
    A->>UV: mount
    A->>UR: mount + install __htsSelectRegion

    par DuckDB pipeline
        UD->>LIB: initRentalDb
        LIB->>CDN: jsdelivr DuckDB worker
        LIB->>CDN: rental_sales.duckdb
        CDN-->>LIB: bytes
        LIB->>D: instantiate + ATTACH
        D-->>LIB: tables
        LIB-->>UD: TableCount[]
        UD-->>A: status ready
    and Manifests pipeline
        UM->>CDN: 9x manifest.json (no-cache)
        CDN-->>UM: bounds + version
        UM-->>A: Manifests record
    and Mappings pipeline
        US->>CDN: suburb_mappings.json
        CDN-->>US: SAL groups + summary
    end

    A->>A: useMemo buildLayers
    A->>DG: layers prop updated
    DG->>MVT: instantiate per manifest
    MVT->>CDN: tile pbf (manifest-gated)
    CDN-->>MVT: tile bytes
    MVT-->>DG: render
    DG-->>B: paint
    B-->>U: visible map
```

</details>

---

## 5. Suburb-click sequence

The lazy-loading boundary: clicking a SAL polygon for the first time triggers a
~1.4 MB Plotly chunk download. Subsequent clicks are instant — only the
DuckDB query re-runs.

```mermaid
sequenceDiagram
    actor U as User
    participant MVT as MVTLayer suburbs-sal
    participant A as App.tsx
    participant SPP as SuburbPlotPanel
    participant LZ as React.lazy loader
    participant SP as SuburbPlot
    participant D as DuckDB-WASM
    participant P as Plotly

    U->>MVT: click polygon
    MVT->>A: setSelection
    A->>SPP: render selection
    SPP->>LZ: load chunk (first click)
    LZ-->>SPP: SuburbPlot
    SPP->>SP: render
    SP->>D: prepared statement query
    D-->>SP: rows grouped by series
    SP->>P: traces + layout
    P-->>U: chart paint
```

*Caption: first click pays the chunk-load cost (~700 KB gzipped); subsequent clicks skip directly to the query.*

<details>
<summary>Detailed suburb-click flow with mappings + theme</summary>

```mermaid
sequenceDiagram
    actor U as User
    participant DG as DeckGL picking
    participant MVT as MVTLayer
    participant LF as makeSalLayer onClick
    participant A as App
    participant UR as useRegionSelection
    participant SPP as SuburbPlotPanel
    participant EB as ErrorBoundary
    participant LZ as React.lazy
    participant SP as SuburbPlot
    participant Q as rental-sales-query
    participant SM as suburb-mappings
    participant D as DuckDB-WASM
    participant T as theme context
    participant P as Plotly

    U->>DG: click event
    DG->>MVT: pick at coords
    MVT->>LF: invoke onClick
    LF->>A: onRegionClick suburb code
    A->>UR: setSelection
    UR-->>A: state change
    A->>SPP: re-render with selection
    SPP->>EB: wrap children
    EB->>LZ: load chunk
    LZ-->>EB: SuburbPlot module
    EB->>SP: render region prop
    SP->>Q: queryRegionTimeSeries
    Q->>D: prepared statement bind
    D-->>Q: rows
    Q-->>SP: SuburbTimeSeries[]
    SP->>SM: lookupSuburb code
    SM-->>SP: market group label
    SP->>T: useOverlayTheme
    T-->>SP: light or dark
    SP->>P: data + layout + theme
    P-->>U: chart visible
```

</details>

---

## Key invariants across lenses

A few cross-cutting facts that recur in multiple lenses:

- **Single source of truth for layers**: `src/lib/layers.ts` owns the catalogue (`SPECS`), the factory functions, the build, the tooltip, and the UI display order. Adding a layer is one row of config.
- **`public/data/` is the contract**: everything the frontend reads is a static asset under `public/data/`. The ETL never talks to a server; the frontend never talks to a database server. The deploy pipeline copies `public/data/` verbatim into `dist/`.
- **Manifest gating**: every MVT layer has a `manifest.json` listing the `(z,x,y)` keys with data. The frontend short-circuits out-of-manifest tile fetches before any HTTP request — keeps the network panel clean and avoids 404 noise.
- **DuckDB-WASM is the only "backend"**: rental/sales queries are JS-driven SQL against a 3.5 MB file the browser owns. There is no API surface to secure, throttle, or scale.
- **e2e drives selection via `window.__htsSelectRegion`**: WebGL canvas picking races headless Playwright's input event loop, so tests bypass the picking step. Manual users still exercise the full click → pick path.
