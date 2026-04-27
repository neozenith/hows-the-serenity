// Live tile-memory accounting for the debug overlay.
//
// One module-level singleton tracks every tile load/unload event across all
// MVTLayers, plus a rolling time-series suitable for a cumulative line chart.
// Subscribers are invoked synchronously on each event so a UI can update
// imperatively (textContent / SVG attribute writes) without round-tripping
// through React state — see the project's Deck.GL-native ADR.
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

export type TileStatsSnapshot = {
	totalBytes: number;
	tileCount: number;
	startedAt: number; // first-event timestamp; chart x-axis origin
	series: ReadonlyArray<TileStatsPoint>;
};

type Listener = (event: TileEvent, snapshot: TileStatsSnapshot) => void;

// Cap so the series doesn't grow unbounded across long sessions; ~500 events
// covers many minutes of pan/zoom and gives the chart enough resolution.
const MAX_SERIES_POINTS = 500;

let totalBytes = 0;
let tileCount = 0;
let startedAt = 0;
const series: TileStatsPoint[] = [];
const sizeCache = new Map<string, number>(); // `${layerId}|${tileKey}` -> bytes
const listeners = new Set<Listener>();

const cacheKey = (layerId: string, tileKey: string) => `${layerId}|${tileKey}`;

const snapshot = (): TileStatsSnapshot => ({
	totalBytes,
	tileCount,
	startedAt,
	series,
});

const emit = (event: TileEvent): void => {
	if (startedAt === 0) startedAt = event.ts;
	series.push({ ts: event.ts, cumulativeBytes: totalBytes, cumulativeCount: tileCount });
	if (series.length > MAX_SERIES_POINTS) series.shift();
	const snap = snapshot();
	for (const fn of listeners) fn(event, snap);
};

export const recordTileSize = (layerId: string, tileKey: string, bytes: number): void => {
	sizeCache.set(cacheKey(layerId, tileKey), bytes);
};

export const recordTileLoad = (layerId: string, tileKey: string): void => {
	const bytes = sizeCache.get(cacheKey(layerId, tileKey)) ?? 0;
	totalBytes += bytes;
	tileCount += 1;
	emit({ ts: performance.now(), layerId, tileKey, bytes, reason: "load" });
};

export const recordTileUnload = (layerId: string, tileKey: string): void => {
	const key = cacheKey(layerId, tileKey);
	const bytes = sizeCache.get(key) ?? 0;
	sizeCache.delete(key);
	totalBytes -= bytes;
	tileCount -= 1;
	emit({ ts: performance.now(), layerId, tileKey, bytes: -bytes, reason: "unload" });
};

export const subscribeTileStats = (fn: Listener): (() => void) => {
	listeners.add(fn);
	return () => {
		listeners.delete(fn);
	};
};

export const getTileStatsSnapshot = (): TileStatsSnapshot => snapshot();
