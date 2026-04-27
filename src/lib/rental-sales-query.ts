import { getRentalDbConn, RENTAL_DB_ALIAS } from "./duckdb";

// One time-series result, grouped by the natural sub-segments the source
// data carries: rental vs sales, dwelling type, bedroom count.
export type SuburbTimeSeries = {
	dataType: "rental" | "sales";
	dwellingType: string; // "house" | "unit" | "all" | ...
	bedrooms: string; // "1" | "2" | "3" | "4" | "all"
	points: ReadonlyArray<{ ts: Date; value: number }>;
};

// Row shape from the prepared statement below — used to drive the grouping.
type Row = {
	data_type: string;
	dwelling_type: string;
	bedrooms: string;
	time_bucket: Date;
	value: number;
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
				ts: new Date(r.time_bucket),
				value: r.value,
			});
		}
		return Array.from(groups.values());
	} finally {
		await stmt.close();
	}
};
