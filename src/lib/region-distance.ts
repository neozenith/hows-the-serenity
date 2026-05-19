// Geographic distance helpers for the /explore RegionPicker.
//
// The picker can sort its options two ways:
//   "alpha" — by name, the original behaviour.
//   "geo"   — by great-circle distance from Melbourne's CBD reference
//             region (SAL 21640 for the suburb tier, LGA 24600 for the
//             LGA tier). The reference region itself sits at the top
//             with distanceKm = 0.
//
// The reference centroid is looked up out of the same
// `{suburb,lga}_centroids.json` files the rest of the app already
// loads — no second source of truth.
//
// Pure-TS so Vitest can exercise the maths and the sort comparator
// directly. The async loader is exposed as a thin hook in
// src/hooks/useCentroids.ts and is not imported here.

import type { RegionKind } from "./rental-sales-query";

export type SortMode = "alpha" | "geo";

export const DEFAULT_SORT_MODE: SortMode = "geo";

export const SORT_MODES: ReadonlyArray<SortMode> = ["alpha", "geo"] as const;

export const SORT_MODE_PARAM = "sort";

export const parseSortMode = (raw: string | null | undefined): SortMode => {
	if (raw == null) return DEFAULT_SORT_MODE;
	const lower = raw.toLowerCase();
	return (SORT_MODES as ReadonlyArray<string>).includes(lower)
		? (lower as SortMode)
		: DEFAULT_SORT_MODE;
};

export const SORT_MODE_LABELS: Readonly<Record<SortMode, string>> = {
	alpha: "A–Z",
	geo: "Geo",
};

// Reference codes for "Melbourne CBD". Static — Melbourne SAL is
// 21640 (suburb_names.json) and Melbourne LGA is 24600
// (lga_names.json). If the ABS ever re-codes these, update here and
// the geo-sort cascades automatically.
export const MELBOURNE_SAL_CODE = "21640";
export const MELBOURNE_LGA_CODE = "24600";

export const referenceCodeFor = (kind: RegionKind): string =>
	kind === "suburb" ? MELBOURNE_SAL_CODE : MELBOURNE_LGA_CODE;

// Centroid file shape: { "21640": [lon, lat], ... }. Both
// suburb_centroids.json and lga_centroids.json use the same flat map.
export type Centroid = readonly [number, number]; // [lon, lat]
export type CentroidMap = Readonly<Record<string, Centroid>>;

// ---------------------------------------------------------------------------
// Haversine — great-circle distance between two (lon, lat) points in km.
// ---------------------------------------------------------------------------
//
// We do NOT use a projected/euclidean metric because Melbourne SALs span
// several hundred km north-south once you include rural Victoria, and
// the small-angle approximation would understate distance materially
// at the tails. Haversine over the ABS-published centroids is plenty
// fast (< 0.05ms per call on a modern laptop) and keeps the metric
// honest at any scale.
//
// EARTH_RADIUS_KM is the IUGG mean radius — the same constant
// `cartopy`, `geopy`, and PostGIS use by default.

const EARTH_RADIUS_KM = 6371.0088;

const toRad = (deg: number): number => (deg * Math.PI) / 180;

export const haversineKm = (a: Centroid, b: Centroid): number => {
	const [lon1, lat1] = a;
	const [lon2, lat2] = b;
	const phi1 = toRad(lat1);
	const phi2 = toRad(lat2);
	const dPhi = toRad(lat2 - lat1);
	const dLambda = toRad(lon2 - lon1);
	const h =
		Math.sin(dPhi / 2) ** 2 +
		Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
	return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
};

// ---------------------------------------------------------------------------
// Sort comparator
// ---------------------------------------------------------------------------
//
// `sortOptionsByDistance` returns a new array; the input is left
// untouched (matches how the rest of `src/lib/` treats inputs).
//
// Options whose code is missing from the centroid map are pushed to the
// END with `distanceKm = +Infinity`, then sorted alphabetically among
// themselves so the tail is still scannable. The reference region (if
// present) sorts to the top with distanceKm = 0.
//
// The same shape is used for `alphaSort` so RegionExplorer can take a
// single `sortOptions(mode, …)` call regardless of which mode is live.

export type RegionOption = { code: string; name: string };

export type RankedOption<O extends RegionOption = RegionOption> = O & {
	distanceKm: number; // +Infinity means "centroid unknown"
	isReference: boolean;
};

export const rankByDistance = <O extends RegionOption>(
	options: ReadonlyArray<O>,
	centroids: CentroidMap,
	referenceCode: string,
): RankedOption<O>[] => {
	const ref = centroids[referenceCode];
	const ranked: RankedOption<O>[] = options.map((o) => {
		const c = centroids[o.code];
		// If we have no reference centroid, every distance is Infinity —
		// the caller can still sort alphabetically among the tail.
		if (!ref || !c) {
			return { ...o, distanceKm: Number.POSITIVE_INFINITY, isReference: false };
		}
		const isRef = o.code === referenceCode;
		return {
			...o,
			distanceKm: isRef ? 0 : haversineKm(ref, c),
			isReference: isRef,
		};
	});
	ranked.sort((a, b) => {
		if (a.distanceKm !== b.distanceKm) return a.distanceKm - b.distanceKm;
		// Infinity-vs-Infinity falls back to name; same-distance ties (rare
		// but possible at centroid-rounding precision) also break by name.
		return a.name.localeCompare(b.name);
	});
	return ranked;
};

export const rankByName = <O extends RegionOption>(
	options: ReadonlyArray<O>,
): RankedOption<O>[] => {
	const ranked: RankedOption<O>[] = options.map((o) => ({
		...o,
		distanceKm: Number.POSITIVE_INFINITY,
		isReference: false,
	}));
	ranked.sort((a, b) => a.name.localeCompare(b.name));
	return ranked;
};

// One-call entry point used by RegionExplorer — picks the right ranking
// based on the URL-driven sort mode. Falls back to alpha when geo mode
// is requested but the centroid map hasn't loaded yet (so the picker
// renders SOMETHING during the brief load window).
export const sortOptions = <O extends RegionOption>(
	options: ReadonlyArray<O>,
	mode: SortMode,
	centroids: CentroidMap | null,
	referenceCode: string,
): RankedOption<O>[] => {
	if (mode === "alpha" || !centroids) return rankByName(options);
	return rankByDistance(options, centroids, referenceCode);
};

// Compact label for the picker row, e.g. "0 km", "3 km", "120 km". The
// reference region prints "0 km"; unknown centroids print nothing
// (caller checks isFinite(distanceKm) before invoking).
export const formatDistanceKm = (distanceKm: number): string => {
	if (!Number.isFinite(distanceKm)) return "";
	if (distanceKm < 0.5) return "0 km";
	if (distanceKm < 10) return `${distanceKm.toFixed(1)} km`;
	return `${Math.round(distanceKm)} km`;
};
