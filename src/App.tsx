import { DeckGL, type MapViewState, MVTLayer } from "deck.gl";
import { useEffect, useRef, useState } from "react";
import { Map as BaseMap } from "react-map-gl/maplibre";
import { initRentalDb, type TableCount } from "@/lib/duckdb";

// MVT tile trees built by the Python ETL — `etl tile sal` and `etl tile isochrone`.
// Layout matches the XYZ scheme MVTLayer expects via URL-template substitution.
const SAL_TILES_URL = `${import.meta.env.BASE_URL}data/tiles/suburbs/{z}/{x}/{y}.pbf`;
const ISO_FOOT_5_TILES_URL = `${import.meta.env.BASE_URL}data/tiles/iso_foot_5/{z}/{x}/{y}.pbf`;
const ISO_FOOT_15_TILES_URL = `${import.meta.env.BASE_URL}data/tiles/iso_foot_15/{z}/{x}/{y}.pbf`;

// Source data ranges (mirror the --min-zoom / --max-zoom passed to each tiler).
// MVTLayer auto-overzooms beyond max — Deck.GL stretches the deepest available
// tile rather than 404'ing on z > maxZoom.
const SAL_TILE_MIN_ZOOM = 6;
const SAL_TILE_MAX_ZOOM = 9;
const ISO_TILE_MIN_ZOOM = 9;
const ISO_TILE_MAX_ZOOM = 12;

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

const App = () => {
	const [status, setStatus] = useState<DbStatus>({
		state: "loading",
		message: "Initialising DuckDB…",
	});
	// React 19 StrictMode double-invokes effects in dev. Guard so we don't
	// instantiate two DuckDB workers on mount.
	const initOnce = useRef(false);

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
	}, []);

	// Layer order matters — first in array is drawn first (under). Suburb
	// boundaries on the bottom; 15-min corridor as the wider catchment;
	// 5-min corridor on top as the "right next to PT" highlight.
	const layers = [
		new MVTLayer({
			id: "suburbs-sal",
			data: SAL_TILES_URL,
			minZoom: SAL_TILE_MIN_ZOOM,
			maxZoom: SAL_TILE_MAX_ZOOM,
			stroked: true,
			filled: true,
			pickable: true,
			getFillColor: [200, 200, 50, 20],
			getLineColor: [200, 200, 50, 180],
			getLineWidth: 2,
			lineWidthMinPixels: 1,
		}),
		new MVTLayer({
			id: "iso-foot-15",
			data: ISO_FOOT_15_TILES_URL,
			minZoom: ISO_TILE_MIN_ZOOM,
			maxZoom: ISO_TILE_MAX_ZOOM,
			stroked: false,
			filled: true,
			pickable: false,
			getFillColor: [80, 180, 220, 50],
		}),
		new MVTLayer({
			id: "iso-foot-5",
			data: ISO_FOOT_5_TILES_URL,
			minZoom: ISO_TILE_MIN_ZOOM,
			maxZoom: ISO_TILE_MAX_ZOOM,
			stroked: false,
			filled: true,
			pickable: false,
			getFillColor: [255, 165, 70, 90],
		}),
	];

	return (
		<div className="absolute inset-0 bg-neutral-900">
			<DeckGL initialViewState={INITIAL_VIEW_STATE} controller layers={layers}>
				<BaseMap mapStyle={MAP_STYLE} />
			</DeckGL>
			<StatusPanel status={status} />
		</div>
	);
};

const DOT_COLOR: Record<DbStatus["state"], string> = {
	loading: "#ffa500",
	ready: "#00c864",
	error: "#ff4444",
};

const StatusPanel = ({ status }: { status: DbStatus }) => (
	<aside className="absolute top-4 left-4 z-10 max-w-xs rounded-md bg-white/95 px-4 py-3 text-sm shadow-md backdrop-blur">
		<h1 className="mb-1 text-base font-semibold text-neutral-900">
			How's the Serenity?
		</h1>
		<div className="mb-2 flex items-center gap-2 text-neutral-700">
			<span
				className="inline-block h-2 w-2 rounded-full"
				style={{ background: DOT_COLOR[status.state] }}
				aria-hidden="true"
			/>
			<span>{status.message}</span>
		</div>
		{status.state === "ready" && status.tables.length > 0 && (
			<ul className="space-y-0.5 text-xs text-neutral-600">
				{status.tables.map((t) => (
					<li key={t.name}>
						<code className="rounded bg-neutral-100 px-1 py-0.5">{t.name}</code>
						{" · "}
						{t.rows.toLocaleString()} rows
					</li>
				))}
			</ul>
		)}
	</aside>
);

export default App;
