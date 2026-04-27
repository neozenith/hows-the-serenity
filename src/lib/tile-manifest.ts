import { load } from "@loaders.gl/core";
import { MVTLoader } from "@loaders.gl/mvt";
import { recordTileSize } from "./tile-stats";

// Schema mirrors etl/tiling/manifest.py — keep field names in sync.
// `version` is a unix-epoch int written at ETL time and used by the
// frontend as a `?v=<version>` cache-bust query string on each tile URL.
export type TileManifest = {
	name: string;
	format: "pbf";
	version: number;
	minZoom: number;
	maxZoom: number;
	bounds: [number, number, number, number];
	tiles: string[];
};

export type LoadedManifest = {
	manifest: TileManifest;
	available: Set<string>;
};

export const loadManifest = async (
	manifestUrl: string,
): Promise<LoadedManifest> => {
	// `cache: "no-cache"` forces an If-None-Match revalidation on every page
	// load — Pages returns 304 (just headers, ~200 B) when the manifest is
	// unchanged, or 200 with the new bytes when it isn't. Without this, the
	// browser would treat the manifest like any other static asset and serve
	// up to 10 minutes of stale data after a deploy.
	const res = await fetch(manifestUrl, { cache: "no-cache" });
	if (!res.ok) {
		throw new Error(`Manifest fetch failed: ${manifestUrl} (${res.status})`);
	}
	const manifest = (await res.json()) as TileManifest;
	return {
		manifest,
		available: new Set(manifest.tiles),
	};
};

// MVTLayer's `getTileData` class method hard-codes the URL template + fetch path
// (it ignores any prop-level override). The `fetch` prop is the hook that DOES
// get called for every tile request — we use it to short-circuit out-of-manifest
// coords before any HTTP request is issued. In-manifest 404s propagate as real
// errors; out-of-manifest coords resolve to an empty array (no fetch, no render,
// no console noise). MVTLayer treats an empty parsed-tile response as "nothing
// to render here" and moves on.
//
// The fetch also records each tile's byte size into tile-stats so the debug
// overlay can compute cumulative memory pressure when onTileLoad fires later.
export const makeGatedTileFetch = (loaded: LoadedManifest) => {
	const TILE_URL_PATTERN = /\/(\d+)\/(\d+)\/(\d+)\.pbf(?:\?|$)/;
	return async (
		url: string,
		context: {
			loadOptions?: unknown;
			signal?: AbortSignal;
			layer?: { id?: string };
		},
	): Promise<unknown> => {
		const match = url.match(TILE_URL_PATTERN);
		const tileKey = match ? `${match[1]}/${match[2]}/${match[3]}` : null;
		if (tileKey && !loaded.available.has(tileKey)) return [];
		// Manual fetch + parse so we can capture the byte size before parsing
		// hands the buffer to loaders.gl (which would then own it). MVTLoader
		// must be passed explicitly — Vite/Pages serve .pbf without a
		// Content-Type, so loaders.gl's auto-detection has nothing to match.
		const response = await fetch(
			url,
			context.signal ? { signal: context.signal } : {},
		);
		if (!response.ok) {
			throw new Error(
				`In-manifest tile fetch failed (manifest claims it exists): ${url} (${response.status})`,
			);
		}
		const buffer = await response.arrayBuffer();
		const layerId = context.layer?.id;
		if (layerId && tileKey) {
			recordTileSize(layerId, tileKey, buffer.byteLength);
		}
		return load(buffer, MVTLoader, context.loadOptions as never);
	};
};
