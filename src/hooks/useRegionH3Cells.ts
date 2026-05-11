import { useEffect, useState } from "react";
import { versionedUrl } from "@/lib/data-version";

// In-memory H3 cell coverage lookups. Loaded once per *enabled* lifetime
// from the two JSON files the ETL publishes via `etl publish region-h3-cells`.
// Each map is keyed by H3 cell id (e.g. "89be6356257ffff") and yields
// the region code (SAL_CODE21 or LGA_CODE24) that contains the cell's
// centroid. The frontend joins this against rental-sales latest-value
// data to colour each cell by its suburb/LGA's median.
//
// The `enabled` flag is the user-facing kill switch: when false (the
// "Rental/Sales hex" layer toggle is off), we skip the fetch entirely
// and drop any previously-loaded maps so the ~3 MB of in-memory cell
// data is released. This matters on memory-constrained machines where
// even loading the JSON can trip the OOM killer.

export type CellLookup = ReadonlyMap<string, string>;

export type RegionH3Cells = {
	suburb: CellLookup;
	lga: CellLookup;
};

const EMPTY: RegionH3Cells = { suburb: new Map(), lga: new Map() };

const fetchCells = async (url: string): Promise<CellLookup> => {
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`failed to fetch ${url}: ${res.status}`);
	}
	const data = (await res.json()) as Record<string, string>;
	return new Map(Object.entries(data));
};

export const useRegionH3Cells = (enabled: boolean): RegionH3Cells => {
	const [cells, setCells] = useState<RegionH3Cells>(EMPTY);

	useEffect(() => {
		if (!enabled) {
			// Drop any previously-loaded maps so GC can reclaim them. The
			// `EMPTY` constant is shared across all disabled instances —
			// no allocation cost on re-disable.
			setCells(EMPTY);
			return;
		}

		// Track cancellation so a fast disable->enable->disable cycle
		// doesn't land a stale fetch into the disabled state.
		let cancelled = false;
		Promise.all([
			fetchCells(versionedUrl("data/suburb_h3_cells.json")),
			fetchCells(versionedUrl("data/lga_h3_cells.json")),
		])
			.then(([suburb, lga]) => {
				if (!cancelled) setCells({ suburb, lga });
			})
			.catch((err: unknown) => {
				console.warn("region-h3-cells fetch failed", err);
				// Stay EMPTY — the H3HexagonLayer will render zero cells.
				// Surface failure is logged so users notice; the rest of
				// the app continues regardless of this one feature.
			});

		return () => {
			cancelled = true;
		};
	}, [enabled]);

	return cells;
};
