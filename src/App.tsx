import { DeckGL, type MapViewState, MVTLayer } from "deck.gl";
import { useEffect, useRef, useState } from "react";
import { Map as BaseMap } from "react-map-gl/maplibre";
import { initRentalDb, type TableCount } from "@/lib/duckdb";
import {
	type LoadedManifest,
	loadManifest,
	makeGatedTileFetch,
} from "@/lib/tile-manifest";

// MVT tile trees built by the Python ETL — `etl tile sal` and `etl tile isochrone`.
// Layout matches the XYZ scheme MVTLayer expects via URL-template substitution.
// Each tile tree carries a manifest.json listing the (z,x,y) coords with data;
// the frontend gates fetches against it so out-of-range coords don't 404.
const TILES_BASE = `${import.meta.env.BASE_URL}data/tiles`;
const SAL_TILES_URL = `${TILES_BASE}/suburbs/{z}/{x}/{y}.pbf`;
const SAL_MANIFEST_URL = `${TILES_BASE}/suburbs/manifest.json`;
const ISO_FOOT_5_TILES_URL = `${TILES_BASE}/iso_foot_5/{z}/{x}/{y}.pbf`;
const ISO_FOOT_5_MANIFEST_URL = `${TILES_BASE}/iso_foot_5/manifest.json`;
const ISO_FOOT_15_TILES_URL = `${TILES_BASE}/iso_foot_15/{z}/{x}/{y}.pbf`;
const ISO_FOOT_15_MANIFEST_URL = `${TILES_BASE}/iso_foot_15/manifest.json`;

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

type LayerKey = "suburbs" | "iso5" | "iso15";

type LayerVisibility = Record<LayerKey, boolean>;

type Manifests = {
	suburbs: LoadedManifest | null;
	iso5: LoadedManifest | null;
	iso15: LoadedManifest | null;
};

const LAYER_DEFS: ReadonlyArray<{
	key: LayerKey;
	label: string;
	hint: string;
}> = [
	{ key: "suburbs", label: "Suburb boundaries", hint: "ABS SAL 2021" },
	{ key: "iso15", label: "15-min walk corridor", hint: "PTV stops · foot" },
	{ key: "iso5", label: "5-min walk corridor", hint: "PTV stops · foot" },
];

const App = () => {
	const [status, setStatus] = useState<DbStatus>({
		state: "loading",
		message: "Initialising DuckDB…",
	});
	const [manifests, setManifests] = useState<Manifests>({
		suburbs: null,
		iso5: null,
		iso15: null,
	});
	const [visible, setVisible] = useState<LayerVisibility>({
		suburbs: true,
		iso5: true,
		iso15: true,
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

		Promise.all([
			loadManifest(SAL_MANIFEST_URL),
			loadManifest(ISO_FOOT_5_MANIFEST_URL),
			loadManifest(ISO_FOOT_15_MANIFEST_URL),
		])
			.then(([suburbs, iso5, iso15]) => setManifests({ suburbs, iso5, iso15 }))
			.catch((err: unknown) => {
				console.error("Tile manifest load failed:", err);
			});
	}, []);

	// Layer order matters — first in array is drawn first (under). Suburb
	// boundaries on the bottom; 15-min corridor as the wider catchment;
	// 5-min corridor on top as the "right next to PT" highlight.
	// Layers are gated until their manifest is loaded — keeps fetches scoped to
	// known-existing tiles.
	const layers = [
		manifests.suburbs &&
			new MVTLayer({
				id: "suburbs-sal",
				data: SAL_TILES_URL,
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
			}),
		manifests.iso15 &&
			new MVTLayer({
				id: "iso-foot-15",
				data: ISO_FOOT_15_TILES_URL,
				minZoom: manifests.iso15.manifest.minZoom,
				maxZoom: manifests.iso15.manifest.maxZoom,
				extent: manifests.iso15.manifest.bounds,
				visible: visible.iso15,
				stroked: false,
				filled: true,
				pickable: false,
				getFillColor: [80, 180, 220, 50],
				fetch: makeGatedTileFetch(manifests.iso15),
			}),
		manifests.iso5 &&
			new MVTLayer({
				id: "iso-foot-5",
				data: ISO_FOOT_5_TILES_URL,
				minZoom: manifests.iso5.manifest.minZoom,
				maxZoom: manifests.iso5.manifest.maxZoom,
				extent: manifests.iso5.manifest.bounds,
				visible: visible.iso5,
				stroked: false,
				filled: true,
				pickable: false,
				getFillColor: [255, 165, 70, 90],
				fetch: makeGatedTileFetch(manifests.iso5),
			}),
	].filter(Boolean);

	const toggle = (key: LayerKey) =>
		setVisible((prev) => ({ ...prev, [key]: !prev[key] }));

	return (
		<div className="absolute inset-0 bg-neutral-900">
			<DeckGL initialViewState={INITIAL_VIEW_STATE} controller layers={layers}>
				<BaseMap mapStyle={MAP_STYLE} />
			</DeckGL>
			<StatusPanel status={status} />
			<LayerPanel visible={visible} onToggle={toggle} />
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

const LayerPanel = ({
	visible,
	onToggle,
}: {
	visible: LayerVisibility;
	onToggle: (key: LayerKey) => void;
}) => (
	<aside className="absolute top-4 right-4 z-10 w-56 rounded-md bg-white/95 px-4 py-3 text-sm shadow-md backdrop-blur">
		<h2 className="mb-2 text-sm font-semibold text-neutral-900">Layers</h2>
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
							<span className="block text-neutral-900">{layer.label}</span>
							<span className="block text-xs text-neutral-500">
								{layer.hint}
							</span>
						</span>
					</label>
				</li>
			))}
		</ul>
	</aside>
);

export default App;
