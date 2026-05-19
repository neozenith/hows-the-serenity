// Async loader for `public/data/{suburb,lga}_centroids.json` — the
// `{ code: [lon, lat] }` maps the /explore RegionPicker uses to sort
// regions by great-circle distance from Melbourne CBD.
//
// One module-scoped cache per kind so navigating between SAL ↔ LGA does
// not re-fetch the file. Cache survives kind toggles for the lifetime
// of the React tree. The fetch is best-effort: failure leaves the cache
// at null and the picker falls back to alphabetical sorting (see
// region-distance.ts → sortOptions).
//
// Same shape as the existing useLgaNames / useObservedRegions hooks in
// RegionExplorer.tsx — match the convention so future readers don't
// have to context-switch.

import { useEffect, useState } from "react";

import { versionedUrl } from "@/lib/data-version";
import type { CentroidMap } from "@/lib/region-distance";
import type { RegionKind } from "@/lib/rental-sales-query";

type Kind = RegionKind;

const FILE_BY_KIND: Readonly<Record<Kind, string>> = {
	suburb: "data/suburb_centroids.json",
	lga: "data/lga_centroids.json",
};

const _cache: Record<Kind, CentroidMap | null> = {
	suburb: null,
	lga: null,
};
const _promises: Record<Kind, Promise<CentroidMap> | null> = {
	suburb: null,
	lga: null,
};

const loadCentroids = (kind: Kind): Promise<CentroidMap> => {
	const cached = _cache[kind];
	if (cached) return Promise.resolve(cached);
	const inflight = _promises[kind];
	if (inflight) return inflight;
	const p = fetch(versionedUrl(FILE_BY_KIND[kind]))
		.then((r) => {
			if (!r.ok) throw new Error(`${FILE_BY_KIND[kind]} ${r.status}`);
			return r.json() as Promise<CentroidMap>;
		})
		.then((d) => {
			_cache[kind] = d;
			return d;
		});
	_promises[kind] = p;
	return p;
};

export const useCentroids = (kind: Kind): CentroidMap | null => {
	const [state, setState] = useState<CentroidMap | null>(() => _cache[kind]);
	useEffect(() => {
		if (_cache[kind]) {
			setState(_cache[kind]);
			return;
		}
		// Reset to null when kind flips so we don't briefly show the wrong
		// tier's centroids during the in-flight fetch.
		setState(null);
		let cancelled = false;
		loadCentroids(kind)
			.then((d) => {
				if (!cancelled) setState(d);
			})
			.catch(() => {
				/* picker falls back to alpha sort */
			});
		return () => {
			cancelled = true;
		};
	}, [kind]);
	return state;
};
