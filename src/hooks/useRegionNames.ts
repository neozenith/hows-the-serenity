import { useEffect, useState } from "react";
import { versionedUrl } from "@/lib/data-version";

// Per-region name lookups for the hex-overlay tooltip. Maps SAL_CODE21 ->
// "Brunswick" and LGA_CODE24 -> "Moreland". Names are stripped of the
// "(Vic.)" state qualifier at ETL time so they match conversational form.
//
// Both files are small (~60 KB / ~2 KB raw, much less gzipped). Loaded
// once at app start, kept in memory for the life of the tab.

export type NameLookup = ReadonlyMap<string, string>;

export type RegionNames = {
	suburb: NameLookup;
	lga: NameLookup;
};

const EMPTY: RegionNames = { suburb: new Map(), lga: new Map() };

const fetchNames = async (url: string): Promise<NameLookup> => {
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`failed to fetch ${url}: ${res.status}`);
	}
	const data = (await res.json()) as Record<string, string>;
	return new Map(Object.entries(data));
};

export const useRegionNames = (): RegionNames => {
	const [names, setNames] = useState<RegionNames>(EMPTY);

	useEffect(() => {
		Promise.all([
			fetchNames(versionedUrl("data/suburb_names.json")),
			fetchNames(versionedUrl("data/lga_names.json")),
		])
			.then(([suburb, lga]) => setNames({ suburb, lga }))
			.catch((err: unknown) => {
				console.warn("region-names fetch failed", err);
				// Stay EMPTY — tooltips will fall back to showing the bare
				// region code. UI degrades but doesn't fail.
			});
	}, []);

	return names;
};
