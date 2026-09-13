// Shareable map-view URL state.
//
// The map route (`/`) mirrors its view into the query string so a copied
// link reproduces exactly what the sender saw:
//
//   ?v=-37.8136,144.9631,9.00           camera: lat,lng,zoom
//   ?v=-37.8136,144.9631,12.50,60,45    …plus pitch,bearing when either ≠ 0
//   &l=lga,suburbs,trainLines           active layers (explicit list)
//   &hex=<seriesId>                     active hex series (when chosen)
//   &3d=1                               hex extrusion on
//
// Layers are an explicit list rather than a diff against defaults: a diff
// link would silently change meaning whenever a default flips. `l=` present
// but empty means "every layer off"; `l` absent means "no opinion" (fall
// back to sessionStorage/defaults).
//
// Writes go through `history.replaceState`, not React Router, so camera
// updates never re-render React (see the Deck.GL-native render-loop ADR).
// Other params on the URL (e.g. `?sources=`) are preserved on every write.

import type { MapViewState } from "deck.gl";
import type { LayerKey, LayerVisibility } from "@/lib/layers";

export const VIEW_PARAM = "v";
export const LAYERS_PARAM = "l";
export const HEX_SERIES_PARAM = "hex";
export const HEX_3D_PARAM = "3d";

export type UrlView = Pick<
	MapViewState,
	"latitude" | "longitude" | "zoom" | "pitch" | "bearing"
>;

// 5 decimals ≈ 1 m at Melbourne's latitude — finer is noise in a link.
const round = (n: number, dp: number): number => {
	const f = 10 ** dp;
	return Math.round(n * f) / f;
};

export const formatView = (vs: UrlView): string => {
	const parts = [
		round(vs.latitude, 5).toString(),
		round(vs.longitude, 5).toString(),
		vs.zoom.toFixed(2),
	];
	const pitch = Math.round(vs.pitch ?? 0);
	// Normalise to 0..359 so -90 and 270 serialise identically.
	const bearing = Math.round((((vs.bearing ?? 0) % 360) + 360) % 360) % 360;
	if (pitch !== 0 || bearing !== 0) parts.push(`${pitch}`, `${bearing}`);
	return parts.join(",");
};

export const parseView = (raw: string | null): UrlView | null => {
	if (!raw) return null;
	const nums = raw.split(",").map(Number);
	if (nums.length !== 3 && nums.length !== 5) return null;
	if (nums.some((n) => !Number.isFinite(n))) return null;
	const [latitude, longitude, zoom, pitch = 0, bearing = 0] = nums as [
		number,
		number,
		number,
		number?,
		number?,
	];
	if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
	if (zoom < 0 || zoom > 24 || pitch < 0 || pitch > 85) return null;
	return { latitude, longitude, zoom, pitch, bearing };
};

export const formatLayers = (visible: LayerVisibility): string =>
	(Object.keys(visible) as LayerKey[]).filter((k) => visible[k]).join(",");

// Returns a full visibility record (every known key set) or null when the
// param is absent. Unknown keys in the URL are ignored so an old link keeps
// working after a layer is renamed or removed.
export const parseLayers = (
	raw: string | null,
	defaults: LayerVisibility,
): LayerVisibility | null => {
	if (raw === null) return null;
	const wanted = new Set(raw.split(",").filter(Boolean));
	const out = { ...defaults };
	for (const k of Object.keys(defaults) as LayerKey[]) out[k] = wanted.has(k);
	return out;
};

export const readParam = (name: string): string | null =>
	new URLSearchParams(window.location.search).get(name);

// Merge `updates` into the current query string (null deletes). Commas are
// left unescaped — they're legal in a query (RFC 3986 sub-delims) and keep
// the link readable. No-ops when nothing changed, so repeated identical
// writes don't burn Safari's replaceState budget.
export const writeParams = (updates: Record<string, string | null>): void => {
	const sp = new URLSearchParams(window.location.search);
	for (const [k, v] of Object.entries(updates)) {
		if (v === null) sp.delete(k);
		else sp.set(k, v);
	}
	const qs = sp.toString().replace(/%2C/gi, ",");
	const next = `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`;
	const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
	if (next === current) return;
	// Preserve history.state: React Router stores its navigation index there.
	window.history.replaceState(window.history.state, "", next);
};
