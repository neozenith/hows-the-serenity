import { useEffect, useState } from "react";
import {
	INITIAL_MANIFESTS,
	LAYER_DIRS,
	type Manifests,
	manifestUrl,
	TILE_LAYER_KEYS,
} from "@/lib/layers";
import { loadManifest } from "@/lib/tile-manifest";

// Loads every tile-layer manifest in parallel. Layers gated by manifest are
// simply absent (return [] from buildLayers) until the fetch completes —
// keeps tile fetches scoped to known-existing tiles.
export const useTileManifests = (): Manifests => {
	const [manifests, setManifests] = useState<Manifests>(INITIAL_MANIFESTS);

	useEffect(() => {
		Promise.all(
			TILE_LAYER_KEYS.map((k) => loadManifest(manifestUrl(LAYER_DIRS[k]))),
		)
			.then((loaded) => {
				const next: Manifests = { ...INITIAL_MANIFESTS };
				TILE_LAYER_KEYS.forEach((k, i) => {
					next[k] = loaded[i] ?? null;
				});
				setManifests(next);
			})
			.catch((err: unknown) => {
				console.error("Tile manifest load failed:", err);
			});
	}, []);

	return manifests;
};
