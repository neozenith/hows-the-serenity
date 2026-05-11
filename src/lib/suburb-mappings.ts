// SAL → rental_sales market group reconciliation, fetched at app startup.
//
// Source of truth lives in the ETL: `etl publish suburb-mappings` produces
// `public/data/suburb_mappings.json`. Schema mirrored here — keep aligned
// with `etl/steps/build_suburb_mappings.py`.
//
// Why this exists: a SAL_CODE21 from the suburb MVT tiles does NOT always
// map 1:1 onto a rental_sales row. Real-estate rental aggregations collapse
// 2-3 adjacent SALs into one group ("North Melbourne-West Melbourne" =
// 21966-22757), and a single SAL can belong to a rental group AND a separate
// sales group at the same time. This mapping precomputes the lookup so the
// chart can render the correct group label per Rental/Sales view, and so we
// can disable the panel entirely for SALs with no data.

export type SuburbGroup = {
	groupCodes: string; // hyphen-joined SAL_CODE21s
	groupLabel: string; // real-estate market label
	groupSize: number; // number of SAL codes in the group (≥ 1)
};

export type SuburbMappingEntry = {
	salName: string;
	stateName: string;
	rental: SuburbGroup | null;
	sales: SuburbGroup | null;
};

export type SuburbMappingsSummary = {
	totalSALs: number;
	withRentalData: number;
	withSalesData: number;
	rentalGroups: number;
	salesGroups: number;
	rentalGroupsMulti: number;
	salesGroupsMulti: number;
	salsNoData: number;
	orphanGroupCodes: number;
};

export type SuburbMappings = {
	version: number;
	salCodes: Record<string, SuburbMappingEntry>;
	summary: SuburbMappingsSummary;
};

let _cache: SuburbMappings | null = null;

export const loadSuburbMappings = async (
	url: string,
): Promise<SuburbMappings> => {
	if (_cache) return _cache;
	// URL is `?v=<dataset-version>`-stamped upstream (see data-version.ts),
	// so cache-busting on a fresh ETL run is handled by URL change rather
	// than `cache: "no-cache"`. Letting the browser cache deterministically
	// per-version means a refresh within one deploy reuses bytes; a new
	// deploy lands as a different URL and forces re-fetch.
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`Suburb mappings fetch failed: ${url} (${res.status})`);
	}
	_cache = (await res.json()) as SuburbMappings;
	return _cache;
};

export const getSuburbMappings = (): SuburbMappings | null => _cache;

export const lookupSuburb = (salCode: string): SuburbMappingEntry | undefined =>
	_cache?.salCodes[salCode];
