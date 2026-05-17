import { getRentalDbConn, RENTAL_DB_ALIAS } from "./duckdb";

// Region kinds the rental_sales table carries. Maps directly to the
// `geospatial_type` column. "suburb" rows resolve via SAL_CODE21, "lga"
// rows via LGA_CODE24.
export type RegionKind = "suburb" | "lga";

// One time-series result, grouped by the natural sub-segments the source
// data carries: rental vs sales, dwelling type, bedroom count.
//
// The `Suburb` prefix on the type name pre-dates the LGA tier; left as-is
// because the *shape* is identical for both region kinds and renaming it
// would ripple through every chart consumer with no semantic gain.
export type SuburbTimeSeries = {
	dataType: "rental" | "sales";
	dwellingType: string; // "house" | "unit" | "all" | ...
	bedrooms: string; // "1" | "2" | "3" | "4" | "all"
	points: ReadonlyArray<{ ts: Date; value: number }>;
	// True when every contributing row was produced by the impute step
	// (etl/steps/impute_coverage.py, source_file LIKE 'imputed:%'). The
	// dwelling-all-bedrooms rollups (Class A), sales SAL all-dwellings
	// (Class C), sales bedroom disaggregation (Class B), and sales LGA
	// roll-ups (Class D) all flip this true. Drives the chart's
	// dotted-line + "· imputed" legend suffix + σ fill band.
	imputed: boolean;
	// Forecast/nowcast continuation for this series — populated by
	// queryRegionForecast in parallel with the observed points. Optional
	// because a series may have no forecast (e.g. observed-only data for
	// a region without bake coverage).
	forecast?: ReadonlyArray<ForecastPoint>;
};

// Row shape from the prepared statement. DuckDB-WASM's DATE handling has
// drifted across versions: sometimes a JS Date, sometimes an Int32 of
// days-since-epoch. `value` is DOUBLE -> JS number; the categorical
// columns are VARCHAR -> string. The `time_bucket` field is `unknown`
// here because we normalize via `tsToDate` below.
export type Row = {
	data_type: string;
	dwelling_type: string;
	bedrooms: string;
	time_bucket: unknown;
	value: number;
	source_file: string | null;
};

export const IMPUTED_SOURCE_PREFIX = "imputed:";

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

// Match the requested region code against the hyphen-joined `geospatial_codes`
// field. For suburbs the source stores codes like "20495" (single SAL) or
// "20495-22038" (a market group spanning multiple SALs). LGA rows are always
// single-coded but we use the same pattern uniformly. `'-' || x || '-'` lets
// us pattern-match a single code as a delimited substring, avoiding false
// positives like "20495" matching "204950".
//
// `geospatial_type` is the discriminator between SAL_CODE21-keyed suburb rows
// and LGA_CODE24-keyed LGA rows; the second bound parameter selects the tier.
const QUERY = `
	SELECT data_type, dwelling_type, bedrooms, time_bucket, value, source_file
	FROM ${RENTAL_DB_ALIAS}.rental_sales
	WHERE statistic = 'median'
	  AND geospatial_type = ?
	  AND '-' || geospatial_codes || '-' LIKE '%-' || ? || '-%'
	ORDER BY data_type, dwelling_type, bedrooms, time_bucket
`;

// Pure grouping — the actual unit-of-test. queryRegionTimeSeries pipes its
// DuckDB rows through this; tests inject synthetic Row[] directly. A series
// is `imputed` when every contributing row carries the imputed: source_file
// prefix; one observed row in the slice is enough to fall back to imputed=false
// (we'd rather under-flag than mis-paint a real observation as synthetic).
export const rowsToSeries = (rows: Row[]): SuburbTimeSeries[] => {
	type MutableSeries = {
		dataType: "rental" | "sales";
		dwellingType: string;
		bedrooms: string;
		points: { ts: Date; value: number }[];
		imputed: boolean;
	};
	const groups = new Map<string, MutableSeries>();
	for (const r of rows) {
		const key = `${r.data_type}|${r.dwelling_type}|${r.bedrooms}`;
		let g = groups.get(key);
		// Explicit boolean — optional chaining alone yields `boolean | undefined`,
		// which would propagate `undefined` through the `&&` aggregation and
		// fail the `imputed: false` expectation on the first observed row.
		const rowIsImputed: boolean =
			r.source_file?.startsWith(IMPUTED_SOURCE_PREFIX) ?? false;
		if (!g) {
			g = {
				dataType: r.data_type as "rental" | "sales",
				dwellingType: r.dwelling_type,
				bedrooms: r.bedrooms,
				points: [],
				imputed: rowIsImputed,
			};
			groups.set(key, g);
		} else {
			// AND across the slice — one observed row downgrades the flag.
			g.imputed = g.imputed && rowIsImputed;
		}
		g.points.push({
			ts: tsToDate(r.time_bucket),
			value: typeof r.value === "number" ? r.value : Number(r.value),
		});
	}
	return Array.from(groups.values());
};

export const queryRegionTimeSeries = async (
	regionKind: RegionKind,
	regionCode: string,
): Promise<SuburbTimeSeries[]> => {
	const conn = getRentalDbConn();
	if (!conn) throw new Error("DuckDB not initialised yet");

	// Prepared statement so the region code is a bound parameter rather than
	// inlined into SQL. Predecessor inlined; we don't.
	const stmt = await conn.prepare(QUERY);
	try {
		const rs = await stmt.query(regionKind, regionCode);
		const rows = rs.toArray() as unknown as Row[];
		return rowsToSeries(rows);
	} finally {
		await stmt.close();
	}
};

// Forecast/nowcast rows joined to a region. Mirrors the `forecasts` table's
// per-row shape post-bake (see etl/steps/forecast_rental_sales.py). Interval
// columns are NULL for bedroom-borrowed rows so the renderer must handle
// missing bounds gracefully.
export type ForecastPoint = {
	ts: Date;
	yHat: number;
	lo80: number | null;
	hi80: number | null;
	lo95: number | null;
	hi95: number | null;
	imputationMethod: string;
	isNowcast: boolean;
};

// Raw row shape coming back from DuckDB-WASM's prepared statement. Exported
// so the pure-TS mapping function can be unit-tested without instantiating
// DuckDB (see src/lib/rental-sales-query.test.ts).
export type ForecastRow = {
	data_type: string;
	dwelling_type: string;
	bedrooms: string;
	ds: unknown;
	y_hat: number;
	y_hat_lo_80: number | null;
	y_hat_hi_80: number | null;
	y_hat_lo_95: number | null;
	y_hat_hi_95: number | null;
	imputation_method: string;
	is_nowcast: boolean;
};

const toNullableNum = (v: number | null | undefined): number | null =>
	v === null || v === undefined ? null : Number(v);

// Pure mapping — the actual unit-of-test for T5.4. DuckDB-WASM's row results
// flow through this; tests inject synthetic ForecastRow[] directly. The
// DuckDB round-trip is covered by Playwright e2e (G6), not Vitest.
export const forecastRowsToPoints = (rows: ForecastRow[]): ForecastPoint[] =>
	rows.map((r) => ({
		ts: tsToDate(r.ds),
		yHat: typeof r.y_hat === "number" ? r.y_hat : Number(r.y_hat),
		lo80: toNullableNum(r.y_hat_lo_80),
		hi80: toNullableNum(r.y_hat_hi_80),
		lo95: toNullableNum(r.y_hat_lo_95),
		hi95: toNullableNum(r.y_hat_hi_95),
		imputationMethod: r.imputation_method,
		isNowcast: Boolean(r.is_nowcast),
	}));

const FORECAST_QUERY = `
	SELECT data_type, dwelling_type, bedrooms, ds,
	       y_hat, y_hat_lo_80, y_hat_hi_80, y_hat_lo_95, y_hat_hi_95,
	       imputation_method, is_nowcast
	FROM ${RENTAL_DB_ALIAS}.forecasts
	WHERE geospatial_type = ?
	  AND '-' || geospatial_codes || '-' LIKE '%-' || ? || '-%'
	ORDER BY data_type, dwelling_type, bedrooms, ds
`;

export const queryRegionForecast = async (
	regionKind: RegionKind,
	regionCode: string,
): Promise<ForecastPoint[]> => {
	const conn = getRentalDbConn();
	if (!conn) throw new Error("DuckDB not initialised yet");
	const stmt = await conn.prepare(FORECAST_QUERY);
	try {
		const rs = await stmt.query(regionKind, regionCode);
		const rows = rs.toArray() as unknown as ForecastRow[];
		return forecastRowsToPoints(rows);
	} finally {
		await stmt.close();
	}
};

// Compose key used to match a forecast bundle to its observed series.
// Same shape as the series partition in SuburbPlot — keeps the join trivial.
export const forecastSeriesKey = (
	dataType: string,
	dwellingType: string,
	bedrooms: string,
): string => `${dataType}|${dwellingType}|${bedrooms}`;

// Group raw forecast rows into per-series buckets keyed by
// `${dataType}|${dwellingType}|${bedrooms}`. Pure function (no DuckDB) so
// it's unit-testable; queryRegionForecastGrouped pipes its DuckDB rows
// through this.
export const forecastRowsToGroupedPoints = (
	rows: ForecastRow[],
): Map<string, ForecastPoint[]> => {
	const out = new Map<string, ForecastPoint[]>();
	for (const r of rows) {
		const key = forecastSeriesKey(r.data_type, r.dwelling_type, r.bedrooms);
		const bucket = out.get(key);
		const point: ForecastPoint = {
			ts: tsToDate(r.ds),
			yHat: typeof r.y_hat === "number" ? r.y_hat : Number(r.y_hat),
			lo80: toNullableNum(r.y_hat_lo_80),
			hi80: toNullableNum(r.y_hat_hi_80),
			lo95: toNullableNum(r.y_hat_lo_95),
			hi95: toNullableNum(r.y_hat_hi_95),
			imputationMethod: r.imputation_method,
			isNowcast: Boolean(r.is_nowcast),
		};
		if (bucket) bucket.push(point);
		else out.set(key, [point]);
	}
	return out;
};

export const queryRegionForecastGrouped = async (
	regionKind: RegionKind,
	regionCode: string,
): Promise<Map<string, ForecastPoint[]>> => {
	const conn = getRentalDbConn();
	if (!conn) throw new Error("DuckDB not initialised yet");
	const stmt = await conn.prepare(FORECAST_QUERY);
	try {
		const rs = await stmt.query(regionKind, regionCode);
		const rows = rs.toArray() as unknown as ForecastRow[];
		return forecastRowsToGroupedPoints(rows);
	} finally {
		await stmt.close();
	}
};

// ---------------------------------------------------------------------------
// forecast_models sidecar — one row per (series_id, model) pair, written
// by the bake alongside the `forecasts` table. Carries the AutoARIMA
// orders + goodness-of-fit + coefficients so the explorer can show
// "what model produced this forecast" beneath the dual chart.
// ---------------------------------------------------------------------------

export type ForecastModel = {
	seriesId: string;
	dataType: "rental" | "sales";
	dwellingType: string;
	bedrooms: string;
	model: string; // 'autoarima_cpi_q' | 'autoarima_annual' | 'bedroom_borrowed'
	// ARIMA(p,d,q)(P,D,Q)[s] — nulls for bedroom_borrowed (no fit).
	arP: number | null;
	arD: number | null;
	arQ: number | null;
	seasonalP: number | null;
	seasonalD: number | null;
	seasonalQ: number | null;
	seasonalPeriod: number | null;
	// Goodness of fit (same).
	sigma2: number | null;
	aicc: number | null;
	nObs: number | null;
	coefficients: Record<string, number>;
	exog: string; // 'cpi' | 'none'
	sourceClass: string; // 'observed' | 'imputed:<class>'
};

type RawForecastModelRow = {
	series_id: string;
	data_type: string;
	dwelling_type: string;
	bedrooms: string;
	model: string;
	ar_p: number | null;
	ar_d: number | null;
	ar_q: number | null;
	seasonal_p: number | null;
	seasonal_d: number | null;
	seasonal_q: number | null;
	seasonal_period: number | null;
	sigma2: number | null;
	aicc: number | null;
	n_obs: number | null;
	coefficients_json: string | null;
	exog: string;
	source_class: string;
};

const parseCoefficients = (json: string | null): Record<string, number> => {
	if (json === null || json === "") return {};
	try {
		const obj = JSON.parse(json) as Record<string, unknown>;
		const out: Record<string, number> = {};
		for (const [k, v] of Object.entries(obj)) {
			const n = typeof v === "number" ? v : Number(v);
			if (Number.isFinite(n)) out[k] = n;
		}
		return out;
	} catch {
		return {};
	}
};

const toNullableInt = (v: number | bigint | null | undefined): number | null =>
	v === null || v === undefined
		? null
		: typeof v === "bigint"
			? Number(v)
			: Number(v);

export const forecastModelRowsToModels = (
	rows: RawForecastModelRow[],
): ForecastModel[] =>
	rows.map((r) => ({
		seriesId: r.series_id,
		dataType: r.data_type as "rental" | "sales",
		dwellingType: r.dwelling_type,
		bedrooms: r.bedrooms,
		model: r.model,
		arP: toNullableInt(r.ar_p),
		arD: toNullableInt(r.ar_d),
		arQ: toNullableInt(r.ar_q),
		seasonalP: toNullableInt(r.seasonal_p),
		seasonalD: toNullableInt(r.seasonal_d),
		seasonalQ: toNullableInt(r.seasonal_q),
		seasonalPeriod: toNullableInt(r.seasonal_period),
		sigma2: toNullableNum(r.sigma2),
		aicc: toNullableNum(r.aicc),
		nObs: toNullableInt(r.n_obs),
		coefficients: parseCoefficients(r.coefficients_json),
		exog: r.exog,
		sourceClass: r.source_class,
	}));

const MODEL_QUERY = `
	SELECT
		series_id, data_type, dwelling_type, bedrooms, model,
		ar_p, ar_d, ar_q,
		seasonal_p, seasonal_d, seasonal_q, seasonal_period,
		sigma2, aicc, n_obs, coefficients_json,
		exog, source_class
	FROM ${RENTAL_DB_ALIAS}.forecast_models
	WHERE geospatial_type = ?
	  AND '-' || geospatial_codes || '-' LIKE '%-' || ? || '-%'
	ORDER BY data_type, dwelling_type, bedrooms
`;

export const queryRegionForecastModels = async (
	regionKind: RegionKind,
	regionCode: string,
): Promise<ForecastModel[]> => {
	const conn = getRentalDbConn();
	if (!conn) throw new Error("DuckDB not initialised yet");
	const stmt = await conn.prepare(MODEL_QUERY);
	try {
		const rs = await stmt.query(regionKind, regionCode);
		const rows = rs.toArray() as unknown as RawForecastModelRow[];
		return forecastModelRowsToModels(rows);
	} finally {
		await stmt.close();
	}
};

// ---------------------------------------------------------------------------
// geographic_hierarchy — agglomerative cluster snapshots. Each row records,
// for one leaf node at one K-cut, the cluster id it belongs to at that cut.
// The bake emits 3 cuts per tier (SAL: K=5/10/15, LGA: K=3/5/10), so a leaf
// has 3 rows in the table.
//
// `parent_cluster_id` is the cluster label at that level, formatted
// `{tier}_L{K}_C{idx}` — not a true graph parent (the data isn't a full
// dendrogram), just the cluster assignment.
// ---------------------------------------------------------------------------

export type ClusterTier = "sal" | "lga";

// ---------------------------------------------------------------------------
// cluster_linkage — HDBSCAN + EVoC dendrograms over polygon centroids.
// One row per tree node: leaves are SAL/LGA codes, interior nodes are
// synthesised cluster ids. The tree spans the FULL hierarchy from leaves
// up to a single root (mega-cluster) per (tier, method).
// ---------------------------------------------------------------------------

export type ClusterMethod = "hdbscan" | "evoc";

export type ClusterLinkageNode = {
	nodeId: string;
	parentId: string | null;
	size: number; // leaves under this node
	distance: number | null; // merge distance (HDBSCAN only)
	isLeaf: boolean;
};

const CLUSTER_LINKAGE_QUERY = `
	SELECT node_id, parent_id, size, distance, is_leaf
	FROM ${RENTAL_DB_ALIAS}.cluster_linkage
	WHERE tier = ? AND method = ?
`;

export const queryClusterLinkage = async (
	tier: ClusterTier,
	method: ClusterMethod,
): Promise<ClusterLinkageNode[]> => {
	const conn = getRentalDbConn();
	if (!conn) throw new Error("DuckDB not initialised yet");
	const stmt = await conn.prepare(CLUSTER_LINKAGE_QUERY);
	try {
		const rs = await stmt.query(tier, method);
		const rows = rs.toArray() as unknown as ReadonlyArray<{
			node_id: string;
			parent_id: string | null;
			size: number | bigint;
			distance: number | null;
			is_leaf: boolean;
		}>;
		return rows.map((r) => ({
			nodeId: String(r.node_id),
			parentId: r.parent_id === null ? null : String(r.parent_id),
			size: typeof r.size === "bigint" ? Number(r.size) : Number(r.size),
			distance: r.distance === null ? null : Number(r.distance),
			isLeaf: Boolean(r.is_leaf),
		}));
	} finally {
		await stmt.close();
	}
};

// ---------------------------------------------------------------------------
// /explore/overview coverage matrix — per (tier, dwelling_type, bedrooms)
// distinct-region counts in three buckets (observed / imputed / forecast),
// emitted by a single UNION ALL over `rental_sales` (split by
// `source_file LIKE 'imputed:%'`) and `forecasts`. Pivoted into the
// render-ready shape by `summariseCoverageRows` (see overview-summary.ts).
// ---------------------------------------------------------------------------

export type CoverageRow = {
	tier: "sal" | "lga";
	dwellingType: string;
	bedrooms: string;
	sourceClass: "observed" | "imputed" | "forecast";
	regionCount: number;
};

// Polygon counts are calculated after splitting vendor multi-SAL group
// strings (e.g. "20018-21677") with STRING_SPLIT + UNNEST so a row keyed
// against two polygons contributes both to the COUNT. This makes the
// table match the polygon overlay the cell drilldown renders.
const COVERAGE_QUERY = `
	WITH rs AS (
		SELECT
			CASE WHEN geospatial_type = 'suburb' THEN 'sal'
			     WHEN geospatial_type = 'lga'    THEN 'lga'
			     ELSE NULL END AS tier,
			dwelling_type,
			bedrooms,
			CASE WHEN source_file LIKE 'imputed:%' THEN 'imputed'
			     ELSE 'observed' END AS source_class,
			COUNT(DISTINCT polygon_code) AS region_count
		FROM (
			SELECT
				geospatial_type, dwelling_type, bedrooms, source_file,
				UNNEST(STRING_SPLIT(geospatial_codes, '-')) AS polygon_code
			FROM ${RENTAL_DB_ALIAS}.rental_sales
			WHERE statistic = 'median'
			  AND dwelling_type <> 'vacant_land'
			  AND bedrooms <> '0'
		)
		GROUP BY 1, 2, 3, 4
	),
	fc AS (
		SELECT
			CASE WHEN geospatial_type = 'suburb' THEN 'sal'
			     WHEN geospatial_type = 'lga'    THEN 'lga'
			     ELSE NULL END AS tier,
			dwelling_type,
			bedrooms,
			'forecast' AS source_class,
			COUNT(DISTINCT polygon_code) AS region_count
		FROM (
			SELECT
				geospatial_type, dwelling_type, bedrooms,
				UNNEST(STRING_SPLIT(geospatial_codes, '-')) AS polygon_code
			FROM ${RENTAL_DB_ALIAS}.forecasts
			WHERE dwelling_type <> 'vacant_land'
			  AND bedrooms <> '0'
		)
		GROUP BY 1, 2, 3
	)
	SELECT tier, dwelling_type, bedrooms, source_class, region_count
	FROM rs
	WHERE tier IS NOT NULL
	UNION ALL
	SELECT tier, dwelling_type, bedrooms, source_class, region_count
	FROM fc
	WHERE tier IS NOT NULL
`;

// Used by /explore/overview's cell drilldown: given a single (tier,
// dwelling, bedrooms, sourceClass) the analyst clicked, return the
// `geospatial_codes` row keys that contribute to that cell. The frontend
// then flattens vendor multi-SAL group strings (`flattenCellCodes` in
// cell-polygons.ts) and feeds the singleton polygon ids into the
// GeoJsonLayer overlay.
//
// Forecast keys come from `forecasts`; observed/imputed both come from
// `rental_sales` split by the `source_file LIKE 'imputed:%'` prefix.
const CELL_KEYS_RENTAL_SALES_QUERY = `
	SELECT DISTINCT geospatial_codes
	FROM ${RENTAL_DB_ALIAS}.rental_sales
	WHERE statistic = 'median'
	  AND dwelling_type = ?
	  AND bedrooms = ?
	  AND geospatial_type = ?
	  AND (
	    (? = 'observed' AND (source_file IS NULL OR source_file NOT LIKE 'imputed:%'))
	    OR (? = 'imputed' AND source_file LIKE 'imputed:%')
	  )
`;

const CELL_KEYS_FORECAST_QUERY = `
	SELECT DISTINCT geospatial_codes
	FROM ${RENTAL_DB_ALIAS}.forecasts
	WHERE dwelling_type = ?
	  AND bedrooms = ?
	  AND geospatial_type = ?
	  AND dwelling_type <> 'vacant_land'
	  AND bedrooms <> '0'
`;

const tierToGeospatialType = (tier: "sal" | "lga"): string =>
	tier === "sal" ? "suburb" : "lga";

export const queryRegionCodesForCell = async (
	tier: "sal" | "lga",
	dwellingType: string,
	bedrooms: string,
	sourceClass: "observed" | "imputed" | "forecast",
): Promise<string[]> => {
	const conn = getRentalDbConn();
	if (!conn) throw new Error("DuckDB not initialised yet");
	const geospatial = tierToGeospatialType(tier);

	if (sourceClass === "forecast") {
		const stmt = await conn.prepare(CELL_KEYS_FORECAST_QUERY);
		try {
			const rs = await stmt.query(dwellingType, bedrooms, geospatial);
			const rows = rs.toArray() as unknown as ReadonlyArray<{
				geospatial_codes: string;
			}>;
			return rows.map((r) => String(r.geospatial_codes));
		} finally {
			await stmt.close();
		}
	}

	const stmt = await conn.prepare(CELL_KEYS_RENTAL_SALES_QUERY);
	try {
		const rs = await stmt.query(
			dwellingType,
			bedrooms,
			geospatial,
			sourceClass,
			sourceClass,
		);
		const rows = rs.toArray() as unknown as ReadonlyArray<{
			geospatial_codes: string;
		}>;
		return rows.map((r) => String(r.geospatial_codes));
	} finally {
		await stmt.close();
	}
};

export const queryCoverageRows = async (): Promise<CoverageRow[]> => {
	const conn = getRentalDbConn();
	if (!conn) throw new Error("DuckDB not initialised yet");
	const stmt = await conn.prepare(COVERAGE_QUERY);
	try {
		const rs = await stmt.query();
		const rows = rs.toArray() as unknown as ReadonlyArray<{
			tier: string;
			dwelling_type: string;
			bedrooms: string;
			source_class: string;
			region_count: number | bigint;
		}>;
		return rows.map((r) => ({
			tier: r.tier as "sal" | "lga",
			dwellingType: String(r.dwelling_type),
			bedrooms: String(r.bedrooms),
			sourceClass: r.source_class as "observed" | "imputed" | "forecast",
			regionCount:
				typeof r.region_count === "bigint"
					? Number(r.region_count)
					: Number(r.region_count),
		}));
	} finally {
		await stmt.close();
	}
};

// ABS Melbourne All-groups CPI quarterly index, base 2011-12 = 100.
// Loaded once per SuburbPlot mount and rendered as a second-y-axis line
// so users can eyeball how a given suburb's rental/sales trajectory
// compares to general inflation.
export type CpiPoint = { ts: Date; index: number };

// Raw CPI row shape coming back from DuckDB-WASM. Exported so the pure-TS
// mapping function can be unit-tested without instantiating DuckDB (same
// test seam pattern as ForecastRow / forecastRowsToPoints).
export type CpiRow = {
	time_bucket: unknown;
	index_value: number | bigint;
};

// Pure mapping — the actual unit-of-test for T6.4. queryCpiSeries pipes its
// DuckDB results through this; tests inject synthetic CpiRow[] directly.
export const cpiRowsToPoints = (rows: CpiRow[]): CpiPoint[] =>
	rows.map((r) => ({
		ts: tsToDate(r.time_bucket),
		index:
			typeof r.index_value === "number" ? r.index_value : Number(r.index_value),
	}));

const CPI_QUERY = `
	SELECT time_bucket, index_value
	FROM ${RENTAL_DB_ALIAS}.cpi
	WHERE region = 'Melbourne'
	ORDER BY time_bucket
`;

export const queryCpiSeries = async (): Promise<CpiPoint[]> => {
	const conn = getRentalDbConn();
	if (!conn) throw new Error("DuckDB not initialised yet");
	const stmt = await conn.prepare(CPI_QUERY);
	try {
		const rs = await stmt.query();
		const rows = rs.toArray() as unknown as CpiRow[];
		return cpiRowsToPoints(rows);
	} finally {
		await stmt.close();
	}
};
