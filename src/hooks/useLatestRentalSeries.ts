import { useEffect, useState } from "react";
import type { DbStatus } from "@/hooks/useDuckDb";
import { getRentalDbConn, RENTAL_DB_ALIAS } from "@/lib/duckdb";
import {
	RENTAL_HEX_SERIES,
	RENTAL_HEX_SERIES_BY_ID,
	type RentalHexSeries,
} from "@/lib/rental-hex-series";

// One series' latest-value-per-region. H3HexagonLayer joins this against
// the per-region H3 cell list at render time, so we just need a fast
// (code -> {value, date}) lookup and per-series colour-domain extents.
// The date is carried per-region (not per-series) because different
// regions can have data spanning different time ranges — a regional
// suburb may only report through 2020 while a metro one is current.

export type RegionLatest = {
	value: number;
	date: Date;
};

export type RentalSeriesValues = {
	series: RentalHexSeries;
	byCode: ReadonlyMap<string, RegionLatest>;
	valueMin: number;
	valueMax: number;
};

// Single run-once query that fans out into every series. `arg_max(value,
// time_bucket)` picks the value at the most recent time per
// (series, region); `MAX(time_bucket)` reports that timestamp so the
// tooltip can show *when* the value was recorded.
const QUERY = `
	SELECT
		data_type,
		dwelling_type,
		bedrooms,
		geospatial_type,
		geospatial_codes,
		arg_max(value, time_bucket) AS value,
		MAX(time_bucket) AS latest_date
	FROM ${RENTAL_DB_ALIAS}.rental_sales
	WHERE statistic = 'median'
	GROUP BY data_type, dwelling_type, bedrooms, geospatial_type, geospatial_codes
`;

type Row = {
	data_type: string;
	dwelling_type: string;
	bedrooms: string;
	geospatial_type: string;
	geospatial_codes: string;
	value: number;
	latest_date: unknown;
};

// DuckDB-WASM's DATE column can arrive as a JS Date, days-since-epoch
// int, ms-since-epoch int, or bigint depending on the runtime / Arrow
// config. Same coercion logic as rental-sales-query.ts.
const MS_PER_DAY = 86_400_000;
const tsToDate = (ts: unknown): Date => {
	if (ts instanceof Date) return ts;
	if (typeof ts === "number") {
		return new Date(ts > 1e10 ? ts : ts * MS_PER_DAY);
	}
	if (typeof ts === "bigint") return new Date(Number(ts));
	return new Date(String(ts));
};

const seriesId = (
	dataType: string,
	regionTier: string,
	dwellingType: string,
	bedrooms: string,
): string => `${dataType}-${regionTier}-${dwellingType}-${bedrooms}`;

export const useLatestRentalSeries = (
	dbStatus: DbStatus,
): ReadonlyMap<string, RentalSeriesValues> => {
	const [data, setData] = useState<ReadonlyMap<string, RentalSeriesValues>>(
		new Map(),
	);

	useEffect(() => {
		if (dbStatus.state !== "ready") return;
		const conn = getRentalDbConn();
		if (!conn) return;

		let cancelled = false;
		(async () => {
			const stmt = await conn.prepare(QUERY);
			try {
				const rs = await stmt.query();
				if (cancelled) return;
				const rows = rs.toArray() as unknown as Row[];

				// Bucket per series. Each row's `geospatial_codes` may be a
				// hyphen-joined market group ("20495-22038") covering several
				// regions; we split and emit one (code -> {value, date}) entry
				// per individual code so the same value+date shows up against
				// each constituent suburb's H3 cells.
				const buckets = new Map<string, Map<string, RegionLatest>>();
				for (const r of rows) {
					const sid = seriesId(
						r.data_type,
						r.geospatial_type,
						r.dwelling_type,
						r.bedrooms,
					);
					if (!RENTAL_HEX_SERIES_BY_ID.has(sid)) continue;
					const value = typeof r.value === "number" ? r.value : Number(r.value);
					if (!Number.isFinite(value)) continue;
					const date = tsToDate(r.latest_date);
					let m = buckets.get(sid);
					if (!m) {
						m = new Map();
						buckets.set(sid, m);
					}
					for (const code of String(r.geospatial_codes).split("-")) {
						m.set(code, { value, date });
					}
				}

				// Materialise final shape with per-series min/max for the
				// colour domain. Computed once here rather than per-render
				// in the layer factory so palette mapping stays stable.
				const result = new Map<string, RentalSeriesValues>();
				for (const series of RENTAL_HEX_SERIES) {
					const byCode = buckets.get(series.id) ?? new Map();
					let lo = Number.POSITIVE_INFINITY;
					let hi = Number.NEGATIVE_INFINITY;
					for (const v of byCode.values()) {
						if (v.value < lo) lo = v.value;
						if (v.value > hi) hi = v.value;
					}
					if (!Number.isFinite(lo)) lo = 0;
					if (!Number.isFinite(hi)) hi = 1;
					result.set(series.id, {
						series,
						byCode,
						valueMin: lo,
						valueMax: hi,
					});
				}
				setData(result);
			} catch (err) {
				console.error("useLatestRentalSeries query failed", err);
			} finally {
				await stmt.close();
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [dbStatus]);

	return data;
};
