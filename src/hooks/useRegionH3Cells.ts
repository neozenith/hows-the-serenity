import { useEffect, useState } from "react";

// In-memory H3 cell coverage lookups. Loaded once at app start from the
// two JSON files the ETL publishes via `etl publish region-h3-cells`.
// Each map is keyed by H3 cell id (e.g. "89be6356257ffff") and yields
// the region code (SAL_CODE21 or LGA_CODE24) that contains the cell's
// centroid. The frontend joins this against rental-sales latest-value
// data to colour each cell by its suburb/LGA's median.

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

export const useRegionH3Cells = (): RegionH3Cells => {
	const [cells, setCells] = useState<RegionH3Cells>(EMPTY);

	useEffect(() => {
		const base = import.meta.env.BASE_URL;
		Promise.all([
			fetchCells(`${base}data/suburb_h3_cells.json`),
			fetchCells(`${base}data/lga_h3_cells.json`),
		])
			.then(([suburb, lga]) => setCells({ suburb, lga }))
			.catch((err: unknown) => {
				console.warn("region-h3-cells fetch failed", err);
				// Stay EMPTY — the H3HexagonLayer will render zero cells.
				// Surface failure is logged so users notice; the rest of
				// the app continues regardless of this one feature.
			});
	}, []);

	return cells;
};
