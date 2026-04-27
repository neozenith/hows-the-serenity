import { DeckGL, GeoJsonLayer, type MapViewState, MVTLayer } from "deck.gl";
import { type RefObject, useEffect, useRef, useState } from "react";
import { Map as BaseMap } from "react-map-gl/maplibre";
import { TileMemoryOverlay } from "@/components/TileMemoryOverlay";
import { initRentalDb, type TableCount } from "@/lib/duckdb";
import {
	type LoadedManifest,
	loadManifest,
	makeGatedTileFetch,
} from "@/lib/tile-manifest";
import { recordTileLoad, recordTileUnload } from "@/lib/tile-stats";

// Wires onTileLoad / onTileUnload props for a layer into the tile-stats
// singleton. The byte size for each tile is captured by the gated fetch
// before these fire; here we just look up & accumulate. Tile objects from
// MVTLayer have a `.index: {x, y, z}` shape.
type TileLifecycleArg = { index: { x: number; y: number; z: number } };
const tileLifecycle = (layerId: string) => ({
	onTileLoad: (tile: TileLifecycleArg) => {
		const { z, x, y } = tile.index;
		recordTileLoad(layerId, `${z}/${x}/${y}`);
	},
	onTileUnload: (tile: TileLifecycleArg) => {
		const { z, x, y } = tile.index;
		recordTileUnload(layerId, `${z}/${x}/${y}`);
	},
});

// MVT tile trees built by the Python ETL — `etl tile sal|isochrone|ptv-lines|ptv-stops`.
// Layout matches the XYZ scheme MVTLayer expects via URL-template substitution.
// Each tile tree carries a manifest.json listing the (z,x,y) coords with data;
// the frontend gates fetches against it so out-of-range coords don't 404.
//
// Cache-busting: the manifest carries a `version` int (unix epoch from when
// the ETL last ran). We append it as `?v=<version>` to every tile URL so the
// browser treats a new ETL run as fresh resources rather than reusing stale
// bytes from its 10-minute Pages cache window.
const TILES_BASE = `${import.meta.env.BASE_URL}data/tiles`;
const tileUrl = (dir: string, version?: number) => {
	const base = `${TILES_BASE}/${dir}/{z}/{x}/{y}.pbf`;
	return version === undefined ? base : `${base}?v=${version}`;
};
const manifestUrl = (dir: string) => `${TILES_BASE}/${dir}/manifest.json`;

// Static GeoJSON layers — small enough (a few KB) that MVT tiling is overhead
// rather than help. Loaded directly via Deck.GL's GeoJsonLayer.
const STATIC_DATA_BASE = `${import.meta.env.BASE_URL}data`;
const COMMUTE_HULLS_TRAIN_URL = `${STATIC_DATA_BASE}/commute_hulls_metro_train.geojson`;
const COMMUTE_HULLS_TRAM_URL = `${STATIC_DATA_BASE}/commute_hulls_metro_tram.geojson`;

// CartoDB's dark-matter style is a free, no-auth MapLibre style. Matches the
// aesthetic of the predecessor VanillaJS site (see docs/context/history.md).
const MAP_STYLE =
	"https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

const INITIAL_VIEW_STATE: MapViewState = {
	longitude: 144.9631,
	latitude: -37.8136,
	zoom: 9,
	pitch: 0,
	bearing: 0,
};

type DbStatus =
	| { state: "loading"; message: string }
	| { state: "ready"; message: string; tables: TableCount[] }
	| { state: "error"; message: string };

// Layers backed by MVT tile trees (have manifests, gated fetch, etc.)
type TileLayerKey =
	| "suburbs"
	| "iso5"
	| "iso15"
	| "trainLines"
	| "trainStops"
	| "tramLines"
	| "tramStops"
	| "regionalTrainLines"
	| "regionalTrainStops";

// Static-GeoJSON layers — too small to be worth tiling.
type StaticLayerKey = "commuteTrain" | "commuteTram";

type LayerKey = TileLayerKey | StaticLayerKey;

type LayerVisibility = Record<LayerKey, boolean>;

// Manifests live for tile layers only.
type Manifests = Record<TileLayerKey, LoadedManifest | null>;

const LAYER_DIRS: Record<TileLayerKey, string> = {
	suburbs: "suburbs",
	iso15: "iso_foot_15",
	iso5: "iso_foot_5",
	trainLines: "ptv_lines_metro_train",
	trainStops: "ptv_stops_metro_train",
	tramLines: "ptv_lines_metro_tram",
	tramStops: "ptv_stops_metro_tram",
	regionalTrainLines: "ptv_lines_regional_train",
	regionalTrainStops: "ptv_stops_regional_train",
};
const TILE_LAYER_KEYS = Object.keys(LAYER_DIRS) as TileLayerKey[];

const LAYER_DEFS: ReadonlyArray<{
	key: LayerKey;
	label: string;
	hint: string;
}> = [
	{ key: "suburbs", label: "Suburb boundaries", hint: "ABS SAL 2021" },
	{ key: "iso15", label: "15-min walk corridor", hint: "PTV stops · foot" },
	{ key: "iso5", label: "5-min walk corridor", hint: "PTV stops · foot" },
	{ key: "trainLines", label: "Train lines", hint: "PTV · METRO TRAIN" },
	{ key: "trainStops", label: "Train stops", hint: "PTV · METRO TRAIN" },
	{ key: "tramLines", label: "Tram lines", hint: "PTV · METRO TRAM" },
	{ key: "tramStops", label: "Tram stops", hint: "PTV · METRO TRAM" },
	{
		key: "regionalTrainLines",
		label: "Regional train lines",
		hint: "PTV · REGIONAL TRAIN",
	},
	{
		key: "regionalTrainStops",
		label: "Regional train stops",
		hint: "PTV · REGIONAL TRAIN",
	},
	{
		key: "commuteTrain",
		label: "Train commute hulls",
		hint: "15/30/45/60-min from Southern Cross",
	},
	{
		key: "commuteTram",
		label: "Tram commute hulls",
		hint: "15/30/45/60-min from Southern Cross",
	},
];

// Hover tooltip — DeckGL invokes this for any pickable layer's hovered
// feature, handles positioning automatically. Returning null hides the
// tooltip; an object surfaces text+style. We branch on which property
// shape was picked because the layers (PTV stops vs SAL suburbs) carry
// different fields.
const pickToTooltip = (info: {
	object?: { properties?: Record<string, unknown> } | null;
}): { text: string } | null => {
	const props = info.object?.properties;
	if (!props) return null;
	if (typeof props.STOP_NAME === "string") {
		const mode = typeof props.MODE === "string" ? props.MODE : "";
		return { text: mode ? `${props.STOP_NAME}\n${mode}` : props.STOP_NAME };
	}
	if (typeof props.SAL_NAME21 === "string") {
		const ste = typeof props.STE_NAME21 === "string" ? props.STE_NAME21 : "";
		return { text: ste ? `${props.SAL_NAME21}\n${ste}` : props.SAL_NAME21 };
	}
	return null;
};

// Brand-ish colors picked to be distinguishable from the warm iso layers
// and the yellow SAL boundaries while still reading as transit-y.
const TRAIN_COLOR: [number, number, number] = [255, 140, 0]; // orange — metro train
const TRAM_COLOR: [number, number, number] = [220, 60, 220]; // magenta — tram
const REGIONAL_TRAIN_COLOR: [number, number, number] = [80, 220, 130]; // green — V/Line

// Commute-tier hull opacity per band — closer-to-CBD = more opaque.
// `undefined` falls back to the smallest opacity. Tiers are 15/30/45/60 min.
const COMMUTE_TIER_ALPHA: Record<number, number> = {
	15: 70,
	30: 50,
	45: 32,
	60: 18,
};
const commuteFillColor =
	(base: [number, number, number]) =>
	(f: { properties?: { transit_time_minutes_nearest_tier?: number } }) => {
		const tier = f.properties?.transit_time_minutes_nearest_tier ?? 60;
		return [...base, COMMUTE_TIER_ALPHA[tier] ?? 18] as [
			number,
			number,
			number,
			number,
		];
	};

const App = () => {
	const [status, setStatus] = useState<DbStatus>({
		state: "loading",
		message: "Initialising DuckDB…",
	});
	const [manifests, setManifests] = useState<Manifests>({
		suburbs: null,
		iso5: null,
		iso15: null,
		trainLines: null,
		trainStops: null,
		tramLines: null,
		tramStops: null,
		regionalTrainLines: null,
		regionalTrainStops: null,
	});
	const [visible, setVisible] = useState<LayerVisibility>({
		suburbs: true,
		iso5: true,
		iso15: true,
		trainLines: true,
		trainStops: true,
		tramLines: true,
		tramStops: true,
		regionalTrainLines: true,
		regionalTrainStops: true,
		commuteTrain: false,
		commuteTram: false,
	});

	// React 19 StrictMode double-invokes effects in dev. Guard so we don't
	// instantiate two DuckDB workers on mount.
	const initOnce = useRef(false);

	// Live zoom label — imperative DOM update via this ref so the panel header
	// can show the current zoom without lifting Deck.GL's viewState into React
	// state (which would recreate the layer array on every pan/zoom frame).
	// The handler is inlined on the DeckGL prop below; that's fine because
	// `App` only re-renders when its React state actually changes — not per
	// viewport frame — so the callback identity churn isn't a hot path. See
	// the project's Deck.GL-native ADR memory.
	const zoomLabelRef = useRef<HTMLSpanElement | null>(null);

	useEffect(() => {
		if (initOnce.current) return;
		initOnce.current = true;

		initRentalDb({
			onProgress: (message) => setStatus({ state: "loading", message }),
		})
			.then((tables) =>
				setStatus({
					state: "ready",
					message: `Connected · ${tables.length} table${tables.length === 1 ? "" : "s"}`,
					tables,
				}),
			)
			.catch((err: unknown) => {
				const message = err instanceof Error ? err.message : String(err);
				setStatus({ state: "error", message });
				console.error("DuckDB init failed:", err);
			});

		Promise.all(
			TILE_LAYER_KEYS.map((k) => loadManifest(manifestUrl(LAYER_DIRS[k]))),
		)
			.then((loaded) => {
				const next = {} as Manifests;
				TILE_LAYER_KEYS.forEach((k, i) => {
					next[k] = loaded[i] ?? null;
				});
				setManifests(next);
			})
			.catch((err: unknown) => {
				console.error("Tile manifest load failed:", err);
			});
	}, []);

	// Layer order matters — first in array is drawn first (under). The stack:
	//   suburbs (bottom)  -> 15-min walk -> 5-min walk -> train lines ->
	//   tram lines -> train stops -> tram stops (top).
	// Lines render under stops so the stop dots aren't half-hidden by the
	// route line going through them. Layers are gated until their manifest
	// is loaded — keeps fetches scoped to known-existing tiles.
	//
	// Per-layer zoom range is enforced via MVTLayer's native `minZoom` /
	// `maxZoom` props, sourced from each manifest. Below `minZoom` the layer
	// neither fetches nor renders — that's the Deck.GL-native way to gate a
	// layer to its tiled-data range. (See ADR memory: don't pull viewState
	// into React for this.)
	const layers = [
		// Commute-tier hulls — background context. Drawn first so transit
		// lines and stops sit on top. Static GeoJSON, no manifest gate.
		new GeoJsonLayer({
			id: "commute-hulls-train",
			data: COMMUTE_HULLS_TRAIN_URL,
			visible: visible.commuteTrain,
			pickable: false,
			stroked: false,
			filled: true,
			getFillColor: commuteFillColor(TRAIN_COLOR),
		}),
		new GeoJsonLayer({
			id: "commute-hulls-tram",
			data: COMMUTE_HULLS_TRAM_URL,
			visible: visible.commuteTram,
			pickable: false,
			stroked: false,
			filled: true,
			getFillColor: commuteFillColor(TRAM_COLOR),
		}),
		manifests.suburbs &&
			new MVTLayer({
				id: "suburbs-sal",
				data: tileUrl(LAYER_DIRS.suburbs, manifests.suburbs.manifest.version),
				minZoom: manifests.suburbs.manifest.minZoom,
				maxZoom: manifests.suburbs.manifest.maxZoom,
				extent: manifests.suburbs.manifest.bounds,
				visible: visible.suburbs,
				stroked: true,
				filled: true,
				pickable: true,
				getFillColor: [200, 200, 50, 20],
				getLineColor: [200, 200, 50, 180],
				getLineWidth: 2,
				lineWidthMinPixels: 1,
				fetch: makeGatedTileFetch(manifests.suburbs),
				...tileLifecycle("suburbs-sal"),
			}),
		manifests.iso15 &&
			new MVTLayer({
				id: "iso-foot-15",
				data: tileUrl(LAYER_DIRS.iso15, manifests.iso15.manifest.version),
				minZoom: manifests.iso15.manifest.minZoom,
				maxZoom: manifests.iso15.manifest.maxZoom,
				extent: manifests.iso15.manifest.bounds,
				visible: visible.iso15,
				stroked: false,
				filled: true,
				pickable: false,
				getFillColor: [80, 180, 220, 50],
				fetch: makeGatedTileFetch(manifests.iso15),
				...tileLifecycle("iso-foot-15"),
			}),
		manifests.iso5 &&
			new MVTLayer({
				id: "iso-foot-5",
				data: tileUrl(LAYER_DIRS.iso5, manifests.iso5.manifest.version),
				minZoom: manifests.iso5.manifest.minZoom,
				maxZoom: manifests.iso5.manifest.maxZoom,
				extent: manifests.iso5.manifest.bounds,
				visible: visible.iso5,
				stroked: false,
				filled: true,
				pickable: false,
				getFillColor: [255, 165, 70, 90],
				fetch: makeGatedTileFetch(manifests.iso5),
				...tileLifecycle("iso-foot-5"),
			}),
		manifests.trainLines &&
			new MVTLayer({
				id: "ptv-lines-train",
				data: tileUrl(
					LAYER_DIRS.trainLines,
					manifests.trainLines.manifest.version,
				),
				minZoom: manifests.trainLines.manifest.minZoom,
				maxZoom: manifests.trainLines.manifest.maxZoom,
				extent: manifests.trainLines.manifest.bounds,
				visible: visible.trainLines,
				stroked: true,
				filled: false,
				pickable: false,
				getLineColor: [...TRAIN_COLOR, 220],
				getLineWidth: 2,
				lineWidthMinPixels: 1.5,
				fetch: makeGatedTileFetch(manifests.trainLines),
				...tileLifecycle("ptv-lines-train"),
			}),
		manifests.tramLines &&
			new MVTLayer({
				id: "ptv-lines-tram",
				data: tileUrl(
					LAYER_DIRS.tramLines,
					manifests.tramLines.manifest.version,
				),
				minZoom: manifests.tramLines.manifest.minZoom,
				maxZoom: manifests.tramLines.manifest.maxZoom,
				extent: manifests.tramLines.manifest.bounds,
				visible: visible.tramLines,
				stroked: true,
				filled: false,
				pickable: false,
				getLineColor: [...TRAM_COLOR, 200],
				getLineWidth: 1.5,
				lineWidthMinPixels: 1,
				fetch: makeGatedTileFetch(manifests.tramLines),
				...tileLifecycle("ptv-lines-tram"),
			}),
		manifests.trainStops &&
			new MVTLayer({
				id: "ptv-stops-train",
				data: tileUrl(
					LAYER_DIRS.trainStops,
					manifests.trainStops.manifest.version,
				),
				minZoom: manifests.trainStops.manifest.minZoom,
				maxZoom: manifests.trainStops.manifest.maxZoom,
				extent: manifests.trainStops.manifest.bounds,
				visible: visible.trainStops,
				pickable: true,
				pointType: "circle",
				pointRadiusUnits: "pixels",
				getPointRadius: 4.5,
				pointRadiusMinPixels: 3,
				stroked: true,
				filled: true,
				getFillColor: [...TRAIN_COLOR, 230],
				getLineColor: [20, 20, 20, 220],
				getLineWidth: 1,
				lineWidthMinPixels: 1,
				fetch: makeGatedTileFetch(manifests.trainStops),
				...tileLifecycle("ptv-stops-train"),
			}),
		manifests.tramStops &&
			new MVTLayer({
				id: "ptv-stops-tram",
				data: tileUrl(
					LAYER_DIRS.tramStops,
					manifests.tramStops.manifest.version,
				),
				minZoom: manifests.tramStops.manifest.minZoom,
				maxZoom: manifests.tramStops.manifest.maxZoom,
				extent: manifests.tramStops.manifest.bounds,
				visible: visible.tramStops,
				pickable: true,
				pointType: "circle",
				pointRadiusUnits: "pixels",
				getPointRadius: 3,
				pointRadiusMinPixels: 2,
				stroked: true,
				filled: true,
				getFillColor: [...TRAM_COLOR, 220],
				getLineColor: [20, 20, 20, 180],
				getLineWidth: 0.75,
				lineWidthMinPixels: 0.75,
				fetch: makeGatedTileFetch(manifests.tramStops),
				...tileLifecycle("ptv-stops-tram"),
			}),
		manifests.regionalTrainLines &&
			new MVTLayer({
				id: "ptv-lines-regional-train",
				data: tileUrl(
					LAYER_DIRS.regionalTrainLines,
					manifests.regionalTrainLines.manifest.version,
				),
				minZoom: manifests.regionalTrainLines.manifest.minZoom,
				maxZoom: manifests.regionalTrainLines.manifest.maxZoom,
				extent: manifests.regionalTrainLines.manifest.bounds,
				visible: visible.regionalTrainLines,
				stroked: true,
				filled: false,
				pickable: false,
				getLineColor: [...REGIONAL_TRAIN_COLOR, 220],
				getLineWidth: 2,
				lineWidthMinPixels: 1.5,
				fetch: makeGatedTileFetch(manifests.regionalTrainLines),
				...tileLifecycle("ptv-lines-regional-train"),
			}),
		manifests.regionalTrainStops &&
			new MVTLayer({
				id: "ptv-stops-regional-train",
				data: tileUrl(
					LAYER_DIRS.regionalTrainStops,
					manifests.regionalTrainStops.manifest.version,
				),
				minZoom: manifests.regionalTrainStops.manifest.minZoom,
				maxZoom: manifests.regionalTrainStops.manifest.maxZoom,
				extent: manifests.regionalTrainStops.manifest.bounds,
				visible: visible.regionalTrainStops,
				pickable: true,
				pointType: "circle",
				pointRadiusUnits: "pixels",
				getPointRadius: 4.5,
				pointRadiusMinPixels: 3,
				stroked: true,
				filled: true,
				getFillColor: [...REGIONAL_TRAIN_COLOR, 230],
				getLineColor: [20, 20, 20, 220],
				getLineWidth: 1,
				lineWidthMinPixels: 1,
				fetch: makeGatedTileFetch(manifests.regionalTrainStops),
				...tileLifecycle("ptv-stops-regional-train"),
			}),
	].filter(Boolean);

	const toggle = (key: LayerKey) =>
		setVisible((prev) => ({ ...prev, [key]: !prev[key] }));

	return (
		<div className="absolute inset-0 bg-neutral-900">
			<DeckGL
				initialViewState={INITIAL_VIEW_STATE}
				onViewStateChange={(params) => {
					// `viewState` is generically typed as MapViewState | TransitionProps;
					// we know it's MapView here so a narrow cast is safe.
					const zoom = (params.viewState as MapViewState).zoom;
					if (zoomLabelRef.current && typeof zoom === "number") {
						zoomLabelRef.current.textContent = `z ${zoom.toFixed(1)}`;
					}
				}}
				controller
				layers={layers}
				getTooltip={pickToTooltip}
			>
				<BaseMap mapStyle={MAP_STYLE} />
			</DeckGL>
			<ControlPanel
				status={status}
				visible={visible}
				onToggle={toggle}
				zoomLabelRef={zoomLabelRef}
			/>
			<TileMemoryOverlay />
		</div>
	);
};

const DOT_COLOR: Record<DbStatus["state"], string> = {
	loading: "#ffa500",
	ready: "#00c864",
	error: "#ff4444",
};

const ControlPanel = ({
	status,
	visible,
	onToggle,
	zoomLabelRef,
}: {
	status: DbStatus;
	visible: LayerVisibility;
	onToggle: (key: LayerKey) => void;
	zoomLabelRef: RefObject<HTMLSpanElement | null>;
}) => {
	const [collapsed, setCollapsed] = useState(false);
	return (
		<aside
			className={`absolute top-4 left-4 z-10 ${
				collapsed ? "w-auto" : "w-64"
			} rounded-md bg-white/95 px-4 py-3 text-sm shadow-md backdrop-blur`}
		>
			<header className="flex items-center justify-between gap-2">
				<div className="flex items-center gap-2">
					<span
						className="inline-block h-2 w-2 rounded-full"
						style={{ background: DOT_COLOR[status.state] }}
						aria-hidden="true"
					/>
					<h1 className="text-base font-semibold text-neutral-900">
						How's the Serenity?
					</h1>
				</div>
				<div className="flex items-center gap-1.5">
					{/* DOM-updated by handleViewStateChange — keeps textContent fresh
					    without round-tripping through React state. */}
					<span
						ref={zoomLabelRef}
						role="status"
						aria-label="Current zoom level"
						className="text-xs tabular-nums text-neutral-500"
					>
						z {INITIAL_VIEW_STATE.zoom.toFixed(1)}
					</span>
					<button
						type="button"
						onClick={() => setCollapsed((c) => !c)}
						aria-expanded={!collapsed}
						aria-label={collapsed ? "Show controls" : "Hide controls"}
						className="cursor-pointer rounded px-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
					>
						<span aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
					</button>
				</div>
			</header>
			{!collapsed && (
				<div className="mt-2 space-y-3">
					<section>
						<p className="text-neutral-700">{status.message}</p>
						{status.state === "ready" && status.tables.length > 0 && (
							<ul className="mt-1 space-y-0.5 text-xs text-neutral-600">
								{status.tables.map((t) => (
									<li key={t.name}>
										<code className="rounded bg-neutral-100 px-1 py-0.5">
											{t.name}
										</code>
										{" · "}
										{t.rows.toLocaleString()} rows
									</li>
								))}
							</ul>
						)}
					</section>
					<hr className="border-neutral-200" />
					<section>
						<h2 className="mb-1.5 text-sm font-semibold text-neutral-900">
							Layers
						</h2>
						<ul className="space-y-1.5">
							{LAYER_DEFS.map((layer) => (
								<li key={layer.key}>
									<label className="flex cursor-pointer items-center gap-2 text-neutral-700">
										<input
											type="checkbox"
											className="h-3.5 w-3.5 cursor-pointer accent-neutral-700"
											checked={visible[layer.key]}
											onChange={() => onToggle(layer.key)}
										/>
										<span className="flex-1">
											<span className="block text-neutral-900">
												{layer.label}
											</span>
											<span className="block text-xs text-neutral-500">
												{layer.hint}
											</span>
										</span>
									</label>
								</li>
							))}
						</ul>
					</section>
				</div>
			)}
		</aside>
	);
};

export default App;
