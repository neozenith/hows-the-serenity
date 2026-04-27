// Live tile-memory accounting for the debug overlay.
//
// Tracks a per-layer cumulative byte/count series across every MVTLayer's
// load/unload events, plus aggregate totals. Subscribers fire synchronously
// on each event so a UI can update imperatively (textContent / SVG attribute
// writes) without round-tripping through React state — see the project's
// Deck.GL-native ADR.
//
// Wiring (already in place — this module is the bookkeeper):
//   gated fetch  -> recordTileSize(layerId, tileKey, bytes)
//   onTileLoad   -> recordTileLoad(layerId, tileKey)
//   onTileUnload -> recordTileUnload(layerId, tileKey)

export type TileEvent = {
	ts: number; // performance.now() at event time
	layerId: string;
	tileKey: string; // "z/x/y"
	bytes: number; // positive on load, negative on unload
	reason: "load" | "unload";
};

export type TileStatsPoint = {
	ts: number;
	cumulativeBytes: number;
	cumulativeCount: number;
};

export type LayerStats = {
	layerId: string;
	totalBytes: number;
	tileCount: number;
	series: ReadonlyArray<TileStatsPoint>;
};

export type TileStatsSnapshot = {
	totalBytes: number; // sum across layers
	tileCount: number; // sum across layers
	startedAt: number; // first-event timestamp; chart x-axis origin
	byLayer: ReadonlyArray<LayerStats>;
};

type Listener = (event: TileEvent, snapshot: TileStatsSnapshot) => void;

// Cap so each layer's series doesn't grow unbounded across long sessions;
// ~500 events per layer covers many minutes of pan/zoom and gives the
// chart enough resolution.
const MAX_SERIES_POINTS_PER_LAYER = 500;

let aggregateBytes = 0;
let aggregateCount = 0;
let startedAt = 0;
const sizeCache = new Map<string, number>(); // `${layerId}|${tileKey}` -> bytes

type MutableLayerStats = {
	layerId: string;
	totalBytes: number;
	tileCount: number;
	series: TileStatsPoint[];
};
const layerMap = new Map<string, MutableLayerStats>();
const listeners = new Set<Listener>();

const cacheKey = (layerId: string, tileKey: string) => `${layerId}|${tileKey}`;

const getOrInit = (layerId: string): MutableLayerStats => {
	let s = layerMap.get(layerId);
	if (!s) {
		s = { layerId, totalBytes: 0, tileCount: 0, series: [] };
		layerMap.set(layerId, s);
	}
	return s;
};

const snapshot = (): TileStatsSnapshot => ({
	totalBytes: aggregateBytes,
	tileCount: aggregateCount,
	startedAt,
	byLayer: Array.from(layerMap.values()),
});

const emit = (event: TileEvent): void => {
	if (startedAt === 0) startedAt = event.ts;
	const layer = getOrInit(event.layerId);
	layer.series.push({
		ts: event.ts,
		cumulativeBytes: layer.totalBytes,
		cumulativeCount: layer.tileCount,
	});
	if (layer.series.length > MAX_SERIES_POINTS_PER_LAYER) layer.series.shift();
	const snap = snapshot();
	for (const fn of listeners) fn(event, snap);
};

export const recordTileSize = (layerId: string, tileKey: string, bytes: number): void => {
	sizeCache.set(cacheKey(layerId, tileKey), bytes);
};

export const recordTileLoad = (layerId: string, tileKey: string): void => {
	const bytes = sizeCache.get(cacheKey(layerId, tileKey)) ?? 0;
	const layer = getOrInit(layerId);
	layer.totalBytes += bytes;
	layer.tileCount += 1;
	aggregateBytes += bytes;
	aggregateCount += 1;
	emit({ ts: performance.now(), layerId, tileKey, bytes, reason: "load" });
};

export const recordTileUnload = (layerId: string, tileKey: string): void => {
	const key = cacheKey(layerId, tileKey);
	const bytes = sizeCache.get(key) ?? 0;
	sizeCache.delete(key);
	const layer = getOrInit(layerId);
	layer.totalBytes -= bytes;
	layer.tileCount -= 1;
	aggregateBytes -= bytes;
	aggregateCount -= 1;
	emit({ ts: performance.now(), layerId, tileKey, bytes: -bytes, reason: "unload" });
};

export const subscribeTileStats = (fn: Listener): (() => void) => {
	listeners.add(fn);
	return () => {
		listeners.delete(fn);
	};
};

export const getTileStatsSnapshot = (): TileStatsSnapshot => snapshot();
