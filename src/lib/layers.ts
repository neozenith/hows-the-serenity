import { PathStyleExtension } from "@deck.gl/extensions";
import { H3HexagonLayer } from "@deck.gl/geo-layers";
import {
	GeoJsonLayer,
	type Layer,
	MVTLayer,
	PathLayer,
	TextLayer,
	TileLayer,
} from "deck.gl";
import type { RentalSeriesValues } from "@/hooks/useLatestRentalSeries";
import type { RegionH3Cells } from "@/hooks/useRegionH3Cells";
import type { NameLookup, RegionNames } from "@/hooks/useRegionNames";
import { versionedUrl } from "@/lib/data-version";
import type { RentalHexSeries } from "@/lib/rental-hex-series";
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
const tileUrl = (dir: string, version?: number) => {
	const base = `${TILES_BASE}/${dir}/{z}/{x}/{y}.pbf`;
	return version === undefined ? base : `${base}?v=${version}`;
};

export const manifestUrl = (dir: string) =>
	`${TILES_BASE}/${dir}/manifest.json`;

// Non-tile static artefacts are resolved through `versionedUrl(...)` at
// factory time — see CommuteHullSpec/LgaSpec.urlPath. Tile URLs use their
// own per-layer cache-bust via the manifest's version field (see
// `tileUrl` above); the two schemes are intentionally independent.
const COMMUTE_HULLS_TRAIN_PATH = "data/commute_hulls_metro_train.geojson";
const COMMUTE_HULLS_TRAM_PATH = "data/commute_hulls_metro_tram.geojson";
const LGA_GEOJSON_PATH = "data/selected_lga_2024_aust_gda2020.geojson";

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
	// Relative-to-public-root path. Resolved to a versioned URL via
	// `versionedUrl(...)` at factory time, not at module load time —
	// the data-version module isn't populated until main.tsx awaits it.
	urlPath: string;
	baseColor: RGB;
	// Lowercase token used in the on-contour text label (e.g. "train 15m").
	modeShort: string;
};

type LgaSpec = {
	kind: "lga";
	key: "lga";
	layerId: "lga";
	label: string;
	hint: string;
	urlPath: string;
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

// Debug overlay: a TileLayer that doesn't fetch anything — it just uses
// Deck.GL's tile-coord math to draw the boundary box and "z/x/y" label
// for every tile visible at the current zoom. Toggleable via the layer
// panel; off by default so it never clutters normal use.
type TileGridSpec = {
	kind: "tileGrid";
	key: "tileGrid";
	layerId: "tile-grid-debug";
	label: string;
	hint: string;
};

// Aggregation overlay for rental/sales latest-value data. Single LayerSpec
// for visibility, but the rendered HexagonLayer is parameterised at build
// time by the currently-active series (from useActiveHexSeries) — only
// one series renders at a time. Default off; user picks a series in the
// control panel.
type HexagonSeriesSpec = {
	kind: "hexagonSeries";
	key: "rentalHex";
	layerId: "rental-hex";
	label: string;
	hint: string;
};

export type LayerSpec =
	| CommuteHullSpec
	| LgaSpec
	| IsoSpec
	| PtvLineSpec
	| PtvStopsSpec
	| SalSpec
	| TileGridSpec
	| HexagonSeriesSpec;

export type LayerKey = LayerSpec["key"];

// Tile-backed keys (everything except static GeoJSON layers, the
// synthetic debug grid, and the aggregation hexagon overlay). MVT-only
// concerns like manifest loading discriminate on this narrower type.
export type TileLayerKey = Exclude<
	LayerKey,
	"lga" | "commuteTrain" | "commuteTram" | "tileGrid" | "rentalHex"
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
		urlPath: COMMUTE_HULLS_TRAIN_PATH,
		baseColor: TRAIN_COLOR,
		modeShort: "train",
	},
	{
		kind: "commuteHull",
		key: "commuteTram",
		layerId: "commute-hulls-tram",
		label: "Tram commute hulls",
		hint: "15/30/45/60-min from Southern Cross",
		urlPath: COMMUTE_HULLS_TRAM_PATH,
		baseColor: TRAM_COLOR,
		modeShort: "tram",
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
		urlPath: LGA_GEOJSON_PATH,
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
	// Aggregation hex overlay — rendered just before the debug grid so
	// it sits above boundary/transit context but below the developer
	// overlay. ON by default but a kill-switch in the Layers panel:
	// turning it off skips the ~3 MB H3 cell JSON fetch entirely, not
	// just the WebGL render. Which series renders is controlled by the
	// top-of-screen picker, which hides itself when this toggle is off.
	{
		kind: "hexagonSeries",
		key: "rentalHex",
		layerId: "rental-hex",
		label: "Rental/Sales hex",
		hint: "H3 pixelated fill · picker controls series",
	},
	// Last in render order so the grid + labels sit above every other
	// layer. Off by default — see INITIAL_VISIBILITY override below.
	{
		kind: "tileGrid",
		key: "tileGrid",
		layerId: "tile-grid-debug",
		label: "Tile grid (debug)",
		hint: "Tile boundaries + z/x/y labels",
	},
];

// UI-side ordering for the layer-toggle list. Differs from render order
// (which is geometry-driven, see catalogue note above) — the panel groups
// region polygons first, then walkability, then transit, then commute hulls.
// "rentalHex" is in the panel as a top-level toggle — turning it off skips
// the H3 cell JSON fetch entirely, not just the render, so users on
// memory-constrained machines can disable the ~3 MB of in-memory cells
// without losing the rest of the app. The top-of-screen series picker
// hides itself when the toggle is off, so there's no "select a series
// but nothing renders" dead state.
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
	"rentalHex",
	// Debug overlay last so it sits at the bottom of the toggle list.
	"tileGrid",
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

// Default visibility: every layer on except the debug-only tile grid.
// Each non-debug layer is sufficiently subtle on its own (LGA + SAL
// outline-only with 5% fill, walkability 10% fill + dotted stroke,
// transit lines + stops, commute hulls dashed) that they layer cleanly
// without fighting for attention. Toggle off via the controls panel as
// needed. The tile-grid debug overlay defaults off so it never clutters
// normal use — turn it on via its checkbox when reporting bugs.
// rentalHex stays *on* in the visibility map at all times — the picker
// controls whether it renders by setting activeHexSeriesId. Defaulting
// it off would require the user to flip a hidden checkbox just to make
// their picker selection visible.
const DEFAULT_OFF: ReadonlySet<LayerKey> = new Set<LayerKey>(["tileGrid"]);
export const INITIAL_VISIBILITY: LayerVisibility = SPECS.reduce((acc, s) => {
	acc[s.key] = !DEFAULT_OFF.has(s.key);
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
		data: versionedUrl(s.urlPath),
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

// --- Commute-hull contour labels --------------------------------------------
//
// One on-map text label per hull tier (e.g. "train 30m"). The label sits at
// the easternmost vertex of the hull's exterior ring — a deterministic anchor
// that has two nice properties: (1) nested hulls grow eastward, so the four
// tier labels stack as a roughly vertical ladder on the right of the map
// rather than collapsing onto one point; (2) anchoring on the line means the
// label rides the contour like a topo-map elevation tag instead of sitting
// in dead space inside the polygon.

type HullLabel = {
	position: [number, number];
	text: string;
};

type HullFeature = {
	geometry?: { type?: string; coordinates?: unknown };
	properties?: {
		MODE?: string;
		transit_time_minutes_nearest_tier?: number;
	};
};

const labelFromFeature = (
	f: HullFeature,
	modeShort: string,
): HullLabel | null => {
	if (f.geometry?.type !== "Polygon") return null;
	const ring = (f.geometry.coordinates as number[][][] | undefined)?.[0];
	if (!ring || ring.length === 0) return null;
	const tier = f.properties?.transit_time_minutes_nearest_tier;
	if (typeof tier !== "number") return null;

	// Easternmost vertex of the exterior ring — see header comment for why.
	let maxLon = Number.NEGATIVE_INFINITY;
	let anchor: [number, number] | null = null;
	for (const v of ring) {
		const lon = v[0];
		const lat = v[1];
		if (lon === undefined || lat === undefined) continue;
		if (lon > maxLon) {
			maxLon = lon;
			anchor = [lon, lat];
		}
	}
	if (!anchor) return null;

	return {
		position: anchor,
		text: `${modeShort} ${Math.round(tier)}m`,
	};
};

// Module-scoped Promise cache so `buildLayers` re-running (every visibility
// toggle, every manifest load) doesn't fire a new fetch each time. Deck.gl
// compares `data` by identity, so handing back the same Promise reference
// also skips re-parsing on the layer side.
const hullLabelCache = new Map<string, Promise<HullLabel[]>>();
const getHullLabels = (
	url: string,
	modeShort: string,
): Promise<HullLabel[]> => {
	let p = hullLabelCache.get(url);
	if (!p) {
		p = (async () => {
			const res = await fetch(url);
			if (!res.ok) {
				throw new Error(`failed to fetch hull labels ${url}: ${res.status}`);
			}
			const fc = (await res.json()) as { features?: HullFeature[] };
			return (fc.features ?? [])
				.map((f) => labelFromFeature(f, modeShort))
				.filter((x): x is HullLabel => x !== null);
		})();
		hullLabelCache.set(url, p);
	}
	return p;
};

const makeCommuteHullLabelLayer = (
	s: CommuteHullSpec,
	visible: boolean,
): Layer =>
	new TextLayer<HullLabel>({
		id: `${s.layerId}-labels`,
		data: getHullLabels(versionedUrl(s.urlPath), s.modeShort),
		visible,
		pickable: false,
		getPosition: (d: HullLabel) => d.position,
		getText: (d: HullLabel) => d.text,
		getColor: [...s.baseColor, 240] as [number, number, number, number],
		getSize: 11,
		sizeUnits: "pixels",
		// Anchor sits on the eastern edge of the hull → flow text outward to
		// the right so the label doesn't overlap the contour line itself.
		getTextAnchor: "start",
		getAlignmentBaseline: "center",
		// Small pixel gap between the anchor vertex and the start of the text
		// so the contour stroke and the glyphs don't visually fuse.
		getPixelOffset: [4, 0],
		fontFamily:
			"system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
		fontWeight: 700,
		background: false,
	});

const makeLgaLayer = (
	s: LgaSpec,
	visible: boolean,
	onRegionClick: (selection: RegionSelection) => void,
): Layer =>
	new GeoJsonLayer({
		id: s.layerId,
		data: versionedUrl(s.urlPath),
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

// --- Tile-coord debug overlay -----------------------------------------------
//
// A TileLayer with `getTileData: () => null` — we don't fetch anything, we
// just piggyback on Deck.GL's tile-coord math to know which (z,x,y) cells
// are in view at the current zoom. For each one, renderSubLayers emits a
// PathLayer for the boundary box and a TextLayer with the "z/x/y" string
// centred in the cell.
//
// `tile.boundingBox` is documented as [[west, south], [east, north]] in
// EPSG:4326 — same coord system as every other layer in this file.

type TileGridDatum = { position: [number, number]; text: string };

type TileSubLayerProps = {
	id: string;
	tile: {
		index: { x: number; y: number; z: number };
		boundingBox: [[number, number], [number, number]];
	};
};

const makeTileGridLayer = (visible: boolean): Layer =>
	new TileLayer({
		id: "tile-grid-debug",
		visible,
		pickable: false,
		minZoom: 0,
		maxZoom: 22,
		// No data fetch — we only want Deck.GL to do the tile-coord math.
		getTileData: () => null,
		renderSubLayers: (props: unknown) => {
			const { id, tile } = props as TileSubLayerProps;
			const [[west, south], [east, north]] = tile.boundingBox;
			const { x, y, z } = tile.index;
			const center: [number, number] = [(west + east) / 2, (south + north) / 2];
			const ring: [number, number][] = [
				[west, south],
				[east, south],
				[east, north],
				[west, north],
				[west, south],
			];
			return [
				new PathLayer<[number, number][]>({
					id: `${id}-outline`,
					data: [ring],
					getPath: (d) => d,
					getColor: [255, 200, 0, 200],
					getWidth: 1,
					widthUnits: "pixels",
					widthMinPixels: 1,
				}),
				new TextLayer<TileGridDatum>({
					id: `${id}-label`,
					data: [{ position: center, text: `${z}/${x}/${y}` }],
					getPosition: (d) => d.position,
					getText: (d) => d.text,
					getColor: [255, 220, 80, 240],
					getSize: 12,
					sizeUnits: "pixels",
					getTextAnchor: "middle",
					getAlignmentBaseline: "center",
					fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
					fontWeight: 700,
					background: true,
					getBackgroundColor: [0, 0, 0, 180],
					backgroundPadding: [4, 2, 4, 2],
				}),
			];
		},
	});

// --- Rental/Sales hex overlay -----------------------------------------------
//
// H3HexagonLayer: one coloured cell per pre-computed H3 region cell, joined
// against the active series' latest-value-per-region map. Produces a
// "pixelated map fill" effect where every cell inside a suburb gets that
// suburb's value, giving the impression of the suburb polygon hex-rasterised
// at H3 resolution 9 (~400m diameter cells).
//
// Pre-computing the per-cell colour at build-layers time (rather than via
// a `getFillColor` callback) means deck.gl just memcpy's the colour buffer —
// no per-cell JS callback overhead during the WebGL upload.

// Six-stop perceptual colour ramp (Viridis-ish — sequential, colourblind-
// safe). Per-cell colour is linearly interpolated between adjacent stops
// based on the cell's value position within the series' [min, max] domain.
const HEX_COLOR_RANGE: ReadonlyArray<[number, number, number]> = [
	[68, 1, 84],
	[71, 44, 122],
	[59, 81, 139],
	[44, 113, 142],
	[33, 144, 141],
	[39, 173, 129],
];

const sampleRamp = (
	value: number,
	min: number,
	max: number,
): [number, number, number] => {
	if (max <= min) return [...HEX_COLOR_RANGE[0]] as [number, number, number];
	const t = Math.max(0, Math.min(1, (value - min) / (max - min)));
	const lastIdx = HEX_COLOR_RANGE.length - 1;
	const pos = t * lastIdx;
	const lo = Math.floor(pos);
	const hi = Math.min(lastIdx, lo + 1);
	const f = pos - lo;
	const a = HEX_COLOR_RANGE[lo];
	const b = HEX_COLOR_RANGE[hi];
	return [
		Math.round(a[0] * (1 - f) + b[0] * f),
		Math.round(a[1] * (1 - f) + b[1] * f),
		Math.round(a[2] * (1 - f) + b[2] * f),
	];
};

// One datum per visible H3 cell. Carries every field the tooltip needs
// so picking is a single object lookup with no follow-up joins. Pre-
// computed colour AND elevation means deck.gl doesn't have to call back
// into JS during the WebGL upload — the cost lives in `buildHexData`
// instead, which only runs when the active series / filter / 3D mode
// changes.
export type H3HexDatum = {
	hexagon: string;
	regionCode: string;
	regionName: string;
	value: number;
	date: Date;
	color: [number, number, number];
	// Pre-normalised elevation in metres. Strict proportionality from
	// zero — a cell with value = half of series max gets half the max
	// elevation. Always computed; only used when the layer is in
	// `extruded: true` mode, otherwise deck.gl ignores `getElevation`.
	elevation: number;
	series: RentalHexSeries;
};

// Max extrusion in metres. Big enough to be visible at metro zooms
// (~z=10) once the user tilts the camera, small enough to not turn the
// CBD into the Twin Towers from outer space.
const HEX_MAX_ELEVATION_M = 5000;

const buildHexData = (
	seriesValues: RentalSeriesValues,
	cells: ReadonlyMap<string, string>,
	names: NameLookup,
	valueFilter: readonly [number, number] | null,
): H3HexDatum[] => {
	const out: H3HexDatum[] = [];
	const series = seriesValues.series;
	// Anchor elevation against the series' max so the tallest cell in the
	// series reaches HEX_MAX_ELEVATION_M and everything else scales
	// proportionally from zero. A 0/0 guard avoids NaN when a series has
	// a single repeated value (max === 0 only happens if max === min === 0,
	// which would still divide cleanly to 0).
	const elevationDenom = seriesValues.valueMax > 0 ? seriesValues.valueMax : 1;
	for (const [cellId, code] of cells) {
		const latest = seriesValues.byCode.get(code);
		if (latest === undefined) continue;
		if (
			valueFilter !== null &&
			(latest.value < valueFilter[0] || latest.value > valueFilter[1])
		)
			continue;
		out.push({
			hexagon: cellId,
			regionCode: code,
			// Names file may be slow to load or genuinely missing for some
			// codes (boundary edge cases) — fall back to the code so the
			// tooltip still shows something rather than "undefined".
			regionName: names.get(code) ?? code,
			value: latest.value,
			date: latest.date,
			color: sampleRamp(
				latest.value,
				seriesValues.valueMin,
				seriesValues.valueMax,
			),
			elevation: (latest.value / elevationDenom) * HEX_MAX_ELEVATION_M,
			series,
		});
	}
	return out;
};

const makeH3HexSeriesLayer = (
	seriesValues: RentalSeriesValues,
	cells: ReadonlyMap<string, string>,
	names: NameLookup,
	valueFilter: readonly [number, number] | null,
	extruded: boolean,
	onRegionClick: (selection: RegionSelection) => void,
	visible: boolean,
): Layer | null => {
	const data = buildHexData(seriesValues, cells, names, valueFilter);
	if (data.length === 0) return null;
	return new H3HexagonLayer<H3HexDatum>({
		id: `rental-hex-${seriesValues.series.id}`,
		data,
		visible,
		// Pickable so hovers can show the tooltip *and* clicks can open the
		// suburb/LGA detail panel. The H3 layer is rendered AFTER the SAL
		// layer in the catalogue, so its onClick wins precedence inside
		// any hex footprint when active — clicking outside any hex falls
		// through to the underlying SAL/LGA layer as before.
		pickable: true,
		onClick: (info) => {
			const obj = info.object as H3HexDatum | undefined;
			if (!obj) return;
			onRegionClick({
				kind: obj.series.regionTier,
				name: obj.regionName,
				code: obj.regionCode,
			});
		},
		getHexagon: (d) => d.hexagon,
		getFillColor: (d) => d.color,
		getElevation: (d) => d.elevation,
		extruded,
		filled: true,
		stroked: false,
		// Uniform 60% across 2D and 3D. In 3D this lets the basemap read
		// through tilted side faces; in 2D it lets underlying SAL / LGA
		// boundaries stay visible. Bump back to a per-mode split if 3D
		// side-faces feel too washed-out.
		opacity: 0.6,
		// Material defaults are fine — deck.gl applies basic Lambertian
		// shading when `extruded: true` so taller cells have visible side
		// shading without us configuring lighting explicitly.
		highPrecision: "auto",
	});
};

export type BuildLayersInput = {
	visible: LayerVisibility;
	manifests: Manifests;
	onRegionClick: (selection: RegionSelection) => void;
	activeHexSeriesId: string | null;
	hexSeriesValues: ReadonlyMap<string, RentalSeriesValues>;
	h3Cells: RegionH3Cells;
	regionNames: RegionNames;
	hexValueFilter: readonly [number, number] | null;
	hex3D: boolean;
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
	activeHexSeriesId,
	hexSeriesValues,
	h3Cells,
	regionNames,
	hexValueFilter,
	hex3D,
}: BuildLayersInput): Layer[] =>
	SPECS.flatMap<Layer>((spec) => {
		switch (spec.kind) {
			case "commuteHull":
				return [
					makeCommuteHullLayer(spec, visible[spec.key]),
					makeCommuteHullLabelLayer(spec, visible[spec.key]),
				];
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
			case "tileGrid":
				return [makeTileGridLayer(visible[spec.key])];
			case "hexagonSeries": {
				if (!activeHexSeriesId) return [];
				const seriesValues = hexSeriesValues.get(activeHexSeriesId);
				if (!seriesValues) return [];
				const tier = seriesValues.series.regionTier;
				const cells = tier === "suburb" ? h3Cells.suburb : h3Cells.lga;
				if (cells.size === 0) return [];
				const names = tier === "suburb" ? regionNames.suburb : regionNames.lga;
				const layer = makeH3HexSeriesLayer(
					seriesValues,
					cells,
					names,
					hexValueFilter,
					hex3D,
					onRegionClick,
					visible[spec.key],
				);
				return layer ? [layer] : [];
			}
			default: {
				// Compile-time exhaustiveness check: TS errors here if a new
				// spec.kind is introduced without a matching case.
				const _exhaustive: never = spec;
				return _exhaustive;
			}
		}
	});

// Rental values are weekly $; sales values are absolute $. Different
// magnitudes warrant different formatting — `$540 /wk` vs `$1,250,000`.
const formatHexValue = (
	value: number,
	dataType: "rental" | "sales",
): string => {
	if (dataType === "rental") {
		return `$${Math.round(value).toLocaleString("en-AU")} /wk`;
	}
	return `$${Math.round(value).toLocaleString("en-AU")}`;
};

// Single shared formatter — much cheaper than constructing a new
// Intl.DateTimeFormat per tooltip invocation.
const HEX_DATE_FMT = new Intl.DateTimeFormat("en-AU", {
	month: "short",
	year: "numeric",
});

const formatDwelling = (dwellingType: string, bedrooms: string): string => {
	const dwellingLabel: Record<string, string> = {
		house: "House",
		unit: "Unit",
		vacant_land: "Vacant land",
		all: "All dwellings",
	};
	const d = dwellingLabel[dwellingType] ?? dwellingType;
	// "All / all" and vacant-land's "0" carry no bedroom info worth showing.
	if (bedrooms === "all" || bedrooms === "0") return d;
	return `${d} · ${bedrooms}-bed`;
};

// Hover tooltip — DeckGL invokes for any pickable layer's hovered feature and
// handles positioning. Returning null hides; an object surfaces text+style.
// We branch on which property shape was picked because the layers carry
// different fields: MVT-backed layers expose GeoJSON properties on the
// picked object, while the H3 hex overlay puts our typed datum directly
// on `info.object` (no `.properties` wrapper).
export const pickToTooltip = (info: {
	object?: { properties?: Record<string, unknown> } | H3HexDatum | null;
}): { text: string } | null => {
	const obj = info.object;
	if (!obj) return null;
	// H3 hex overlay datum — recognise by the shape we control. Full
	// granular detail per the picker's "show me what this represents"
	// contract: region name + code, value (formatted by data type),
	// dwelling + bedrooms, date the value was recorded, H3 cell id.
	if ("hexagon" in obj && typeof obj.hexagon === "string") {
		const tierLabel = obj.series.regionTier === "suburb" ? "SAL" : "LGA";
		const lines = [
			`${obj.regionName} (${tierLabel} ${obj.regionCode})`,
			formatHexValue(obj.value, obj.series.dataType),
			formatDwelling(obj.series.dwellingType, obj.series.bedrooms),
			`As of ${HEX_DATE_FMT.format(obj.date)}`,
			`H3 ${obj.hexagon}`,
		];
		return { text: lines.join("\n") };
	}
	const props = "properties" in obj ? obj.properties : undefined;
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
