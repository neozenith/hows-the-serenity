import { load } from "@loaders.gl/core";
import { MVTLoader } from "@loaders.gl/mvt";

// Schema mirrors etl/tiling/manifest.py — keep field names in sync.
export type TileManifest = {
	name: string;
	format: "pbf";
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
	const res = await fetch(manifestUrl);
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
export const makeGatedTileFetch = (loaded: LoadedManifest) => {
	const TILE_URL_PATTERN = /\/(\d+)\/(\d+)\/(\d+)\.pbf(?:\?|$)/;
	return async (
		url: string,
		context: { loadOptions?: unknown; signal?: AbortSignal },
	): Promise<unknown> => {
		const match = url.match(TILE_URL_PATTERN);
		if (match) {
			const [, z, x, y] = match;
			const key = `${z}/${x}/${y}`;
			if (!loaded.available.has(key)) return [];
		}
		// Fall through to loaders.gl with MVTLoader passed explicitly. We can't
		// rely on auto-detection from the response MIME type — Vite/Pages serve
		// .pbf files without a Content-Type, so the loader registry has nothing
		// to match against.
		return load(url, MVTLoader, context.loadOptions as never);
	};
};
