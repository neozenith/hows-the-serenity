import { PathStyleExtension } from "@deck.gl/extensions";
import { GeoJsonLayer, type Layer, MVTLayer } from "deck.gl";
import type { RegionSelection } from "./region";
import { type LoadedManifest, makeGatedTileFetch } from "./tile-manifest";
import { recordTileLoad, recordTileUnload } from "./tile-stats";

// MVT tile trees built by the Python ETL — `etl tile sal|isochrone|ptv-lines|ptv-stops`.
// Each tile tree carries a manifest.json listing the (z,x,y) coords with data;
// the frontend gates fetches against it so out-of-range coords don't 404.
//
// Cache-busting: the manifest carries a `version` int (unix epoch from when
// the ETL last ran). We append it as `?v=<version>` to every tile URL so the
// browser treats a new ETL run as fresh resources rather than reusing stale
// bytes from its 10-minute Pages cache window.
const TILES_BASE = `${import.meta.env.BASE_URL}data/tiles`;
const STATIC_DATA_BASE = `${import.meta.env.BASE_URL}data`;

const tileUrl = (dir: string, version?: number) => {
	const base = `${TILES_BASE}/${dir}/{z}/{x}/{y}.pbf`;
	return version === undefined ? base : `${base}?v=${version}`;
};

export const manifestUrl = (dir: string) =>
	`${TILES_BASE}/${dir}/manifest.json`;

const COMMUTE_HULLS_TRAIN_URL = `${STATIC_DATA_BASE}/commute_hulls_metro_train.geojson`;
const COMMUTE_HULLS_TRAM_URL = `${STATIC_DATA_BASE}/commute_hulls_metro_tram.geojson`;
const LGA_GEOJSON_URL = `${STATIC_DATA_BASE}/selected_lga_2024_aust_gda2020.geojson`;

// Official PTV brand colours: Metro blue, Yarra Trams green, V/Line purple.
// Sourced from PTV's brand guidelines — these match the printed network maps
// and station signage.
type RGB = [number, number, number];
const TRAIN_COLOR: RGB = [31, 117, 188]; // PTV #1F75BC
const TRAM_COLOR: RGB = [120, 190, 32]; // Yarra Trams #78BE20
const REGIONAL_TRAIN_COLOR: RGB = [88, 44, 131]; // V/Line #582C83

// Commute-tier hull alpha per band — closer-to-CBD = more opaque, fades
// outward so the boundary "recedes" with travel time. Linear ramp 50%→80%
// (128→204 in 0–255 space). Tiers are 15/30/45/60 min from Southern Cross.
const COMMUTE_TIER_ALPHA: Record<number, number> = {
	15: 204,
	30: 178,
	45: 153,
	60: 128,
};
const commuteTierColor =
	(base: RGB) =>
	(f: { properties?: { transit_time_minutes_nearest_tier?: number } }) => {
		const tier = f.properties?.transit_time_minutes_nearest_tier ?? 60;
		return [...base, COMMUTE_TIER_ALPHA[tier] ?? 18] as [
			number,
			number,
			number,
			number,
		];
	};

// MVT tile lifecycle — wires onTileLoad/onTileUnload into the tile-stats
// singleton. The byte size for each tile is captured by the gated fetch
// before these fire; here we just look up & accumulate.
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

// --- Layer catalogue ---------------------------------------------------------
//
// One discriminated-union spec per layer. The catalogue is ordered for
// rendering — first = bottom of the stack, last = top (and topmost-pickable
// wins click precedence). UI order is a separate projection (LAYER_DISPLAY_DEFS).
//
// Render order:
//   commute hulls (bottom) → LGA → 15-min walk → 5-min walk → train lines →
//   tram lines → train stops → tram stops → regional train lines → regional
//   train stops → SAL suburbs (top).
// Lines render under stops so the stop dots aren't half-hidden by the route
// line going through them. SAL renders last so its boundary lines + faint fill
// always read above transit context — they're the click target for the suburb
// plot panel and need to win z-order against every other layer (including
// picking precedence).

type CommuteHullSpec = {
	kind: "commuteHull";
	key: "commuteTrain" | "commuteTram";
	layerId: string;
	label: string;
	hint: string;
	url: string;
	baseColor: RGB;
};

type LgaSpec = {
	kind: "lga";
	key: "lga";
	layerId: "lga";
	label: string;
	hint: string;
	url: string;
};

type IsoSpec = {
	kind: "iso";
	key: "iso15" | "iso5";
	layerId: string;
	label: string;
	hint: string;
	dir: string;
	color: RGB;
};

type PtvLineSpec = {
	kind: "ptvLine";
	key: "trainLines" | "tramLines" | "regionalTrainLines";
	layerId: string;
	label: string;
	hint: string;
	dir: string;
	baseColor: RGB;
	alpha: number;
};

type PtvStopsSpec = {
	kind: "ptvStops";
	key: "trainStops" | "tramStops" | "regionalTrainStops";
	layerId: string;
	label: string;
	hint: string;
	dir: string;
	baseColor: RGB;
	fillAlpha: number;
	outlineAlpha: number;
};

type SalSpec = {
	kind: "sal";
	key: "suburbs";
	layerId: "suburbs-sal";
	label: string;
	hint: string;
	dir: string;
};

export type LayerSpec =
	| CommuteHullSpec
	| LgaSpec
	| IsoSpec
	| PtvLineSpec
	| PtvStopsSpec
	| SalSpec;

export type LayerKey = LayerSpec["key"];

// Tile-backed keys (everything except static GeoJSON layers). MVT-only
// concerns like manifest loading discriminate on this narrower type.
export type TileLayerKey = Exclude<
	LayerKey,
	"lga" | "commuteTrain" | "commuteTram"
>;

export type LayerVisibility = Record<LayerKey, boolean>;
export type Manifests = Record<TileLayerKey, LoadedManifest | null>;

const SPECS: readonly LayerSpec[] = [
	{
		kind: "commuteHull",
		key: "commuteTrain",
		layerId: "commute-hulls-train",
		label: "Train commute hulls",
		hint: "15/30/45/60-min from Southern Cross",
		url: COMMUTE_HULLS_TRAIN_URL,
		baseColor: TRAIN_COLOR,
	},
	{
		kind: "commuteHull",
		key: "commuteTram",
		layerId: "commute-hulls-tram",
		label: "Tram commute hulls",
		hint: "15/30/45/60-min from Southern Cross",
		url: COMMUTE_HULLS_TRAM_URL,
		baseColor: TRAM_COLOR,
	},
	// LGA polygons — clickable for LGA-tier rental data. Drawn under SAL so
	// when both layers are on, SAL (last in the catalogue) wins click
	// precedence inside its smaller polygons; LGA picks up clicks that land
	// outside any SAL (rare in metro Vic, common in regional Vic). Pink-ish
	// stroke distinguishes it from SAL's yellow.
	{
		kind: "lga",
		key: "lga",
		layerId: "lga",
		label: "LGA boundaries",
		hint: "ABS LGA 2024 · click for LGA-tier rental data",
		url: LGA_GEOJSON_URL,
	},
	{
		kind: "iso",
		key: "iso15",
		layerId: "iso-foot-15",
		label: "15-min walk corridor",
		hint: "PTV stops · foot",
		dir: "iso_foot_15",
		color: [80, 180, 220],
	},
	{
		kind: "iso",
		key: "iso5",
		layerId: "iso-foot-5",
		label: "5-min walk corridor",
		hint: "PTV stops · foot",
		dir: "iso_foot_5",
		color: [255, 165, 70],
	},
	{
		kind: "ptvLine",
		key: "trainLines",
		layerId: "ptv-lines-train",
		label: "Train lines",
		hint: "PTV · METRO TRAIN",
		dir: "ptv_lines_metro_train",
		baseColor: TRAIN_COLOR,
		alpha: 220,
	},
	{
		kind: "ptvLine",
		key: "tramLines",
		layerId: "ptv-lines-tram",
		label: "Tram lines",
		hint: "PTV · METRO TRAM",
		dir: "ptv_lines_metro_tram",
		baseColor: TRAM_COLOR,
		alpha: 200,
	},
	{
		kind: "ptvStops",
		key: "trainStops",
		layerId: "ptv-stops-train",
		label: "Train stops",
		hint: "PTV · METRO TRAIN",
		dir: "ptv_stops_metro_train",
		baseColor: TRAIN_COLOR,
		fillAlpha: 230,
		outlineAlpha: 220,
	},
	{
		kind: "ptvStops",
		key: "tramStops",
		layerId: "ptv-stops-tram",
		label: "Tram stops",
		hint: "PTV · METRO TRAM",
		dir: "ptv_stops_metro_tram",
		baseColor: TRAM_COLOR,
		fillAlpha: 220,
		outlineAlpha: 180,
	},
	{
		kind: "ptvLine",
		key: "regionalTrainLines",
		layerId: "ptv-lines-regional-train",
		label: "Regional train lines",
		hint: "PTV · REGIONAL TRAIN",
		dir: "ptv_lines_regional_train",
		baseColor: REGIONAL_TRAIN_COLOR,
		alpha: 220,
	},
	{
		kind: "ptvStops",
		key: "regionalTrainStops",
		layerId: "ptv-stops-regional-train",
		label: "Regional train stops",
		hint: "PTV · REGIONAL TRAIN",
		dir: "ptv_stops_regional_train",
		baseColor: REGIONAL_TRAIN_COLOR,
		fillAlpha: 230,
		outlineAlpha: 220,
	},
	{
		kind: "sal",
		key: "suburbs",
		layerId: "suburbs-sal",
		label: "Suburb boundaries",
		hint: "ABS SAL 2021",
		dir: "suburbs",
	},
];

// UI-side ordering for the layer-toggle list. Differs from render order
// (which is geometry-driven, see catalogue note above) — the panel groups
// region polygons first, then walkability, then transit, then commute hulls.
const DISPLAY_ORDER: readonly LayerKey[] = [
	"lga",
	"suburbs",
	"iso15",
	"iso5",
	"trainLines",
	"trainStops",
	"tramLines",
	"tramStops",
	"regionalTrainLines",
	"regionalTrainStops",
	"commuteTrain",
	"commuteTram",
];

const SPEC_BY_KEY = SPECS.reduce(
	(acc, spec) => {
		acc[spec.key] = spec;
		return acc;
	},
	{} as Record<LayerKey, LayerSpec>,
);

const isTileLayerSpec = (
	s: LayerSpec,
): s is IsoSpec | PtvLineSpec | PtvStopsSpec | SalSpec =>
	s.kind === "iso" ||
	s.kind === "ptvLine" ||
	s.kind === "ptvStops" ||
	s.kind === "sal";

export const TILE_LAYER_KEYS: readonly TileLayerKey[] = SPECS.filter(
	isTileLayerSpec,
).map((s) => s.key);

export const LAYER_DIRS: Record<TileLayerKey, string> = SPECS.reduce(
	(acc, s) => {
		if (isTileLayerSpec(s)) acc[s.key] = s.dir;
		return acc;
	},
	{} as Record<TileLayerKey, string>,
);

// Default visibility: every layer on. Each is sufficiently subtle on its own
// (LGA + SAL outline-only with 5% fill, walkability 10% fill + dotted stroke,
// transit lines + stops, commute hulls dashed) that they layer cleanly without
// fighting for attention. Toggle off via the controls panel as needed.
export const INITIAL_VISIBILITY: LayerVisibility = SPECS.reduce((acc, s) => {
	acc[s.key] = true;
	return acc;
}, {} as LayerVisibility);

export const INITIAL_MANIFESTS: Manifests = TILE_LAYER_KEYS.reduce((acc, k) => {
	acc[k] = null;
	return acc;
}, {} as Manifests);

// Projected catalogue for the layer-toggle UI.
export const LAYER_DISPLAY_DEFS: ReadonlyArray<{
	key: LayerKey;
	label: string;
	hint: string;
}> = DISPLAY_ORDER.map((key) => {
	const spec = SPEC_BY_KEY[key];
	return { key, label: spec.label, hint: spec.hint };
});

// --- Layer factories ---------------------------------------------------------

const makeCommuteHullLayer = (s: CommuteHullSpec, visible: boolean): Layer =>
	new GeoJsonLayer({
		id: s.layerId,
		data: s.url,
		visible,
		pickable: false,
		stroked: true,
		filled: false,
		getLineColor: commuteTierColor(s.baseColor),
		getLineWidth: 4,
		lineWidthMinPixels: 3,
		// Dashed stroke pattern in line-width units (multiplied by stroke width
		// at render time), so [3,2] reads as ~3px solid / ~2px gap on a 1px
		// stroke. PathStyleExtension is what enables dash machinery — without
		// it, getDashArray is silently ignored.
		getDashArray: [3, 2],
		dashJustified: true,
		extensions: [new PathStyleExtension({ dash: true })],
	});

const makeLgaLayer = (
	s: LgaSpec,
	visible: boolean,
	onRegionClick: (selection: RegionSelection) => void,
): Layer =>
	new GeoJsonLayer({
		id: s.layerId,
		data: s.url,
		visible,
		pickable: true,
		stroked: true,
		filled: true,
		getFillColor: [240, 100, 200, 13], // ≈5% pink fill, matches SAL faintness
		getLineColor: [240, 100, 200, 180],
		getLineWidth: 2,
		lineWidthMinPixels: 1.5,
		onClick: (info: {
			object?: { properties?: Record<string, unknown> } | null;
		}) => {
			const props = info.object?.properties;
			const name = props?.LGA_NAME24;
			const rawCode = props?.LGA_CODE24;
			// LGA_CODE24 is numeric in the source GeoJSON (5-digit int).
			// Coerce to string so it matches the DuckDB VARCHAR column.
			const code =
				typeof rawCode === "string"
					? rawCode
					: typeof rawCode === "number"
						? String(rawCode)
						: null;
			if (typeof name === "string" && code !== null) {
				onRegionClick({ kind: "lga", name, code });
			}
		},
	});

const makeIsoLayer = (
	s: IsoSpec,
	manifest: LoadedManifest,
	visible: boolean,
): Layer =>
	new MVTLayer({
		id: s.layerId,
		data: tileUrl(s.dir, manifest.manifest.version),
		minZoom: manifest.manifest.minZoom,
		maxZoom: manifest.manifest.maxZoom,
		extent: manifest.manifest.bounds,
		visible,
		stroked: true,
		filled: true,
		pickable: false,
		// 10% fill + fine dotted stroke. Fill is a soft area-tint; the dotted
		// edge gives the corridor a sketched, "approximate" feel that
		// distinguishes it from the precise tile/road grid.
		getFillColor: [...s.color, 26] as [number, number, number, number],
		getLineColor: [...s.color, 200] as [number, number, number, number],
		getLineWidth: 0.5,
		lineWidthMinPixels: 1,
		getDashArray: [1, 1.5],
		dashJustified: true,
		extensions: [new PathStyleExtension({ dash: true })],
		fetch: makeGatedTileFetch(manifest),
		...tileLifecycle(s.layerId),
	});

const makePtvLineLayer = (
	s: PtvLineSpec,
	manifest: LoadedManifest,
	visible: boolean,
): Layer =>
	new MVTLayer({
		id: s.layerId,
		data: tileUrl(s.dir, manifest.manifest.version),
		minZoom: manifest.manifest.minZoom,
		maxZoom: manifest.manifest.maxZoom,
		extent: manifest.manifest.bounds,
		visible,
		stroked: true,
		filled: false,
		pickable: false,
		getLineColor: [...s.baseColor, s.alpha] as [number, number, number, number],
		getLineWidth: 2,
		lineWidthMinPixels: 1.5,
		fetch: makeGatedTileFetch(manifest),
		...tileLifecycle(s.layerId),
	});

const makePtvStopsLayer = (
	s: PtvStopsSpec,
	manifest: LoadedManifest,
	visible: boolean,
): Layer =>
	new MVTLayer({
		id: s.layerId,
		data: tileUrl(s.dir, manifest.manifest.version),
		minZoom: manifest.manifest.minZoom,
		maxZoom: manifest.manifest.maxZoom,
		extent: manifest.manifest.bounds,
		visible,
		pickable: true,
		pointType: "circle",
		pointRadiusUnits: "pixels",
		// Stop radius = 1.1 × line thickness. With unified line width 1.5px (the
		// pixel floor on PTV lines at metro zoom), that's 1.65px radius →
		// 3.3px diameter — barely larger than the line, while still registering
		// as a station marker.
		getPointRadius: 1.65,
		pointRadiusMinPixels: 1.65,
		stroked: true,
		filled: true,
		getFillColor: [...s.baseColor, s.fillAlpha] as [
			number,
			number,
			number,
			number,
		],
		getLineColor: [20, 20, 20, s.outlineAlpha],
		getLineWidth: 0.5,
		lineWidthMinPixels: 0.5,
		fetch: makeGatedTileFetch(manifest),
		...tileLifecycle(s.layerId),
	});

const makeSalLayer = (
	s: SalSpec,
	manifest: LoadedManifest,
	visible: boolean,
	onRegionClick: (selection: RegionSelection) => void,
): Layer =>
	new MVTLayer({
		id: s.layerId,
		data: tileUrl(s.dir, manifest.manifest.version),
		minZoom: manifest.manifest.minZoom,
		maxZoom: manifest.manifest.maxZoom,
		extent: manifest.manifest.bounds,
		visible,
		stroked: true,
		filled: true,
		pickable: true,
		getFillColor: [200, 200, 50, 13], // 13/255 ≈ 5%
		getLineColor: [200, 200, 50, 60],
		getLineWidth: 2,
		lineWidthMinPixels: 1,
		fetch: makeGatedTileFetch(manifest),
		onClick: (info: {
			object?: { properties?: Record<string, unknown> } | null;
		}) => {
			const props = info.object?.properties;
			const name = props?.SAL_NAME21;
			const rawCode = props?.SAL_CODE21;
			// SAL_CODE21 is a string in our MVT tiles, but be defensive in case
			// the encoder ever emits an integer for numeric-looking codes.
			const code =
				typeof rawCode === "string"
					? rawCode
					: typeof rawCode === "number"
						? String(rawCode)
						: null;
			if (typeof name === "string" && code !== null) {
				onRegionClick({ kind: "suburb", name, code });
			}
		},
		...tileLifecycle(s.layerId),
	});

export type BuildLayersInput = {
	visible: LayerVisibility;
	manifests: Manifests;
	onRegionClick: (selection: RegionSelection) => void;
};

// Walk the catalogue in render order; produce one deck.gl Layer per spec, or
// nothing if a tiled layer's manifest hasn't loaded yet. Layers gated by
// manifest are simply absent until the fetch completes — keeps tile fetches
// scoped to known-existing tiles. Per-layer zoom range is enforced via
// MVTLayer's native minZoom/maxZoom props sourced from each manifest.
export const buildLayers = ({
	visible,
	manifests,
	onRegionClick,
}: BuildLayersInput): Layer[] =>
	SPECS.flatMap<Layer>((spec) => {
		switch (spec.kind) {
			case "commuteHull":
				return [makeCommuteHullLayer(spec, visible[spec.key])];
			case "lga":
				return [makeLgaLayer(spec, visible[spec.key], onRegionClick)];
			case "iso": {
				const m = manifests[spec.key];
				return m ? [makeIsoLayer(spec, m, visible[spec.key])] : [];
			}
			case "ptvLine": {
				const m = manifests[spec.key];
				return m ? [makePtvLineLayer(spec, m, visible[spec.key])] : [];
			}
			case "ptvStops": {
				const m = manifests[spec.key];
				return m ? [makePtvStopsLayer(spec, m, visible[spec.key])] : [];
			}
			case "sal": {
				const m = manifests[spec.key];
				return m
					? [makeSalLayer(spec, m, visible[spec.key], onRegionClick)]
					: [];
			}
			default: {
				// Compile-time exhaustiveness check: TS errors here if a new
				// spec.kind is introduced without a matching case.
				const _exhaustive: never = spec;
				return _exhaustive;
			}
		}
	});

// Hover tooltip — DeckGL invokes for any pickable layer's hovered feature and
// handles positioning. Returning null hides; an object surfaces text+style.
// We branch on which property shape was picked because the layers (PTV stops
// vs SAL suburbs vs LGAs) carry different fields.
export const pickToTooltip = (info: {
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
	if (typeof props.LGA_NAME24 === "string") {
		return { text: `${props.LGA_NAME24}\nLGA` };
	}
	return null;
};
