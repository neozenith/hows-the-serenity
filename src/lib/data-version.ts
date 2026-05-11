// Single global cache-bust version for every non-tile static artefact.
//
// At startup, `main.tsx` awaits `loadDataVersion()` before rendering
// React. That populates the module-level `_version` so every consumer
// can call `versionedUrl(...)` synchronously — there's no async dance
// per fetch site.
//
// Why URL-versioning (not request `cache: "no-cache"`):
// 1. Intermediary CDN caches (Cloudflare, etc.) honour distinct URLs;
//    `?v=<ts>` lets them aggressively cache each version forever, with
//    a sharp invalidation cliff on a new ETL run.
// 2. No per-load conditional GET round trip per artefact — once the
//    browser has bytes for `?v=<X>`, it serves them locally forever.
//
// The tradeoff is one extra fetch at startup for `version.json` itself,
// which uses `cache: "no-cache"` so it's always fresh. ~65 bytes, single
// round trip — usually well under the time saved by skipping conditional
// GETs on every other artefact.
//
// Tiles do NOT use this global version. Each MVT tile tree's
// `manifest.json` carries its own per-layer version int, because
// re-tiling one layer shouldn't invalidate CDN cache for unchanged
// layers. The two schemes are intentionally orthogonal.

let _version: number | null = null;

const VERSION_URL = `${import.meta.env.BASE_URL}data/version.json`;

// Fallback if version.json fails to load (pre-first-ETL deploy, network
// failure during cold start, etc.). Zero ensures every URL still has a
// `?v=` segment so the browser caches deterministically; consumers see
// stale data only until the next page load when version.json succeeds.
const FALLBACK_VERSION = 0;

export const loadDataVersion = async (): Promise<number> => {
	try {
		const res = await fetch(VERSION_URL, { cache: "no-cache" });
		if (!res.ok) {
			console.warn(
				`data-version: fetch ${VERSION_URL} -> ${res.status}, using fallback`,
			);
			_version = FALLBACK_VERSION;
			return _version;
		}
		const data = (await res.json()) as unknown;
		if (
			typeof data === "object" &&
			data !== null &&
			"version" in data &&
			typeof (data as { version: unknown }).version === "number"
		) {
			_version = (data as { version: number }).version;
			return _version;
		}
		console.warn("data-version: malformed version.json, using fallback", data);
		_version = FALLBACK_VERSION;
		return _version;
	} catch (e) {
		console.warn("data-version: load failed, using fallback", e);
		_version = FALLBACK_VERSION;
		return _version;
	}
};

// Synchronous URL builder. `path` is relative to public/data, e.g.
// "data/suburb_h3_cells.json". Returns "<BASE_URL><path>?v=<version>".
// Throws if called before `loadDataVersion()` resolved — that's a code
// bug (consumer ran before main.tsx awaited), not a runtime input issue.
export const versionedUrl = (path: string): string => {
	if (_version === null) {
		throw new Error(
			`versionedUrl(${path}) called before loadDataVersion() resolved. ` +
				"main.tsx must await loadDataVersion() before rendering React.",
		);
	}
	const base = import.meta.env.BASE_URL;
	return `${base}${path}?v=${_version}`;
};

// Read-only accessor for UI surfaces that want to display the version
// (e.g. a "Data last refreshed" line). Returns null if not yet loaded.
export const getDataVersion = (): number | null => _version;
