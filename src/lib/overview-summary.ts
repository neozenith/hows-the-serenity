// Pure helpers for the /explore/overview page. The page asks four
// questions per region tier (SAL/LGA):
//   1. How many regions exist in the tier universe?
//   2. How many have observed (non-imputed) source data?
//   3. Per (dwelling_type, bedrooms) permutation — how many regions are
//      represented in observed, imputed, and forecast tables?
//
// These helpers do not touch DuckDB or the network. They take flat row
// inputs (from one DuckDB GROUP BY and one universe JSON fetch) and
// pivot them into a render-ready shape the React component can iterate.
// Pure so they're unit-tested with no fixtures.

export type RegionTier = "sal" | "lga";

export type CoverageInputRow = {
	tier: RegionTier;
	dwellingType: string;
	bedrooms: string;
	sourceClass: "observed" | "imputed" | "forecast";
	regionCount: number;
};

export type CoverageSlice = {
	dwellingType: string;
	bedrooms: string;
	observed: number;
	imputed: number;
	forecast: number;
};

export type TierSummary = {
	tier: RegionTier;
	totalRegions: number;
	observedRegions: number;
	slices: CoverageSlice[];
};

export type RegionTotals = {
	sal: { total: number; observed: number };
	lga: { total: number; observed: number };
};

const sliceKey = (dt: string, br: string): string => `${dt}|${br}`;

// Pivot flat input rows into per-tier slice tables. Slices are sorted by
// (dwellingType, bedrooms) for deterministic rendering — analysts compare
// the table across snapshots, so row order must be stable.
export const summariseCoverageRows = (
	rows: ReadonlyArray<CoverageInputRow>,
	totals: RegionTotals,
): TierSummary[] => {
	const byTier = new Map<RegionTier, Map<string, CoverageSlice>>();
	for (const tier of ["sal", "lga"] as const) {
		byTier.set(tier, new Map());
	}
	for (const r of rows) {
		const slices = byTier.get(r.tier);
		if (!slices) continue;
		const k = sliceKey(r.dwellingType, r.bedrooms);
		let slice = slices.get(k);
		if (!slice) {
			slice = {
				dwellingType: r.dwellingType,
				bedrooms: r.bedrooms,
				observed: 0,
				imputed: 0,
				forecast: 0,
			};
			slices.set(k, slice);
		}
		slice[r.sourceClass] = r.regionCount;
	}
	return (["sal", "lga"] as const).map((tier) => {
		const slices = [...(byTier.get(tier)?.values() ?? [])].sort((a, b) =>
			a.dwellingType === b.dwellingType
				? a.bedrooms.localeCompare(b.bedrooms)
				: a.dwellingType.localeCompare(b.dwellingType),
		);
		return {
			tier,
			totalRegions: totals[tier].total,
			observedRegions: totals[tier].observed,
			slices,
		};
	});
};
