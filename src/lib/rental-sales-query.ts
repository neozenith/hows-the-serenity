import { getRentalDbConn, RENTAL_DB_ALIAS } from "./duckdb";

// One time-series result, grouped by the natural sub-segments the source
// data carries: rental vs sales, dwelling type, bedroom count.
export type SuburbTimeSeries = {
	dataType: "rental" | "sales";
	dwellingType: string; // "house" | "unit" | "all" | ...
	bedrooms: string; // "1" | "2" | "3" | "4" | "all"
	points: ReadonlyArray<{ ts: Date; value: number }>;
};

// Row shape from the prepared statement. DuckDB-WASM's DATE handling has
// drifted across versions: sometimes a JS Date, sometimes an Int32 of
// days-since-epoch. `value` is DOUBLE -> JS number; the categorical
// columns are VARCHAR -> string. The `time_bucket` field is `unknown`
// here because we normalize via `tsToDate` below.
type Row = {
	data_type: string;
	dwelling_type: string;
	bedrooms: string;
	time_bucket: unknown;
	value: number;
};

// Coerce DuckDB-WASM's DATE value into a JS Date, regardless of which
// representation the runtime hands us back.
const MS_PER_DAY = 86_400_000;
const tsToDate = (ts: unknown): Date => {
	if (ts instanceof Date) return ts;
	if (typeof ts === "number") {
		// Heuristic: small numbers are days-since-epoch (DuckDB DATE format),
		// large numbers are ms-since-epoch (already converted). 1e10 ms is
		// well past 1970; 1e10 days is millions of years — clear separator.
		return new Date(ts > 1e10 ? ts : ts * MS_PER_DAY);
	}
	if (typeof ts === "bigint") {
		// Could come through as bigint in some Arrow configs.
		return new Date(Number(ts));
	}
	return new Date(String(ts));
};

// Match by SAL_CODE21 against the hyphen-joined `geospatial_codes` field.
// The schema-mapped extract stores codes like "20495" (single suburb) or
// "20495-22038" (a real-estate "suburb group" containing multiple SALs).
// `'-' || x || '-'` lets us pattern-match a single code as a delimited
// substring, avoiding false positives like "20495" matching "204950".
const QUERY = `
	SELECT data_type, dwelling_type, bedrooms, time_bucket, value
	FROM ${RENTAL_DB_ALIAS}.rental_sales
	WHERE statistic = 'median'
	  AND geospatial_type = 'suburb'
	  AND '-' || geospatial_codes || '-' LIKE '%-' || ? || '-%'
	ORDER BY data_type, dwelling_type, bedrooms, time_bucket
`;

export const querySuburbTimeSeries = async (
	salCode: string,
): Promise<SuburbTimeSeries[]> => {
	const conn = getRentalDbConn();
	if (!conn) throw new Error("DuckDB not initialised yet");

	// Prepared statement so the SAL_CODE21 is a bound parameter rather than
	// inlined into SQL. Predecessor inlined; we don't.
	const stmt = await conn.prepare(QUERY);
	try {
		const rs = await stmt.query(salCode);
		const rows = rs.toArray() as unknown as Row[];

		// Group rows into series by (data_type, dwelling_type, bedrooms).
		// Rows are already sorted, so series come out in a stable order.
		const groups = new Map<string, SuburbTimeSeries>();
		for (const r of rows) {
			const key = `${r.data_type}|${r.dwelling_type}|${r.bedrooms}`;
			let g = groups.get(key);
			if (!g) {
				g = {
					dataType: r.data_type as "rental" | "sales",
					dwellingType: r.dwelling_type,
					bedrooms: r.bedrooms,
					points: [],
				};
				groups.set(key, g);
			}
			(g.points as { ts: Date; value: number }[]).push({
				ts: tsToDate(r.time_bucket),
				value: typeof r.value === "number" ? r.value : Number(r.value),
			});
		}
		return Array.from(groups.values());
	} finally {
		await stmt.close();
	}
};
