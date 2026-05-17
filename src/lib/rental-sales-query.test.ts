// First Vitest in src/. Tests the pure-TS row-shape transformation that the
// queryRegionForecast wrapper pipes its DuckDB results through. The live
// DuckDB round-trip is covered by Playwright e2e (G6); here we only verify
// the pure mapping — per the G5 ADR "T5.4 unit-test seam".

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
	type CpiRow,
	cpiRowsToPoints,
	type ForecastRow,
	forecastRowsToPoints,
	type Row,
	rowsToSeries,
} from "./rental-sales-query";

// Vitest runs from project root; this resolves to the sibling source file.
const SOURCE_PATH = resolve(process.cwd(), "src/lib/rental-sales-query.ts");

const SYNTHETIC_ROWS: ForecastRow[] = [
	{
		data_type: "rental",
		dwelling_type: "all",
		bedrooms: "all",
		ds: new Date("2025-12-01"),
		y_hat: 650.0,
		y_hat_lo_80: 630.0,
		y_hat_hi_80: 670.0,
		y_hat_lo_95: 615.0,
		y_hat_hi_95: 685.0,
		imputation_method: "nowcast_sarima_cpi",
		is_nowcast: true,
	},
	{
		data_type: "rental",
		dwelling_type: "all",
		bedrooms: "all",
		// Number input — days-since-epoch (DuckDB DATE representation).
		ds: 20453,
		y_hat: 655.0,
		y_hat_lo_80: 632.0,
		y_hat_hi_80: 678.0,
		y_hat_lo_95: 615.0,
		y_hat_hi_95: 695.0,
		imputation_method: "nowcast_sarima_cpi",
		is_nowcast: true,
	},
	{
		// Bedroom-borrowed row — NULL interval bounds.
		data_type: "sales",
		dwelling_type: "house",
		bedrooms: "3",
		// bigint input — some Arrow configs hand back bigints.
		ds: BigInt(new Date("2023-12-01").getTime()),
		y_hat: 780_000.0,
		y_hat_lo_80: null,
		y_hat_hi_80: null,
		y_hat_lo_95: null,
		y_hat_hi_95: null,
		imputation_method: "nowcast_bedroom_borrowed",
		is_nowcast: true,
	},
];

describe("forecastRowsToPoints", () => {
	it("returns expected shape for each row", () => {
		const points = forecastRowsToPoints(SYNTHETIC_ROWS);
		expect(points.length).toBe(SYNTHETIC_ROWS.length);
		for (const p of points) {
			expect(p.ts).toBeInstanceOf(Date);
			expect(typeof p.yHat).toBe("number");
			expect(Number.isFinite(p.yHat)).toBe(true);
			expect(typeof p.imputationMethod).toBe("string");
			expect(typeof p.isNowcast).toBe("boolean");
		}
	});

	it("preserves interval ordering when bounds are present", () => {
		const points = forecastRowsToPoints(SYNTHETIC_ROWS);
		for (const p of points) {
			if (
				p.lo95 !== null &&
				p.lo80 !== null &&
				p.hi80 !== null &&
				p.hi95 !== null
			) {
				expect(p.lo95).toBeLessThanOrEqual(p.lo80);
				expect(p.lo80).toBeLessThanOrEqual(p.yHat);
				expect(p.yHat).toBeLessThanOrEqual(p.hi80);
				expect(p.hi80).toBeLessThanOrEqual(p.hi95);
			}
		}
	});

	it("passes through NULL interval bounds for bedroom-borrowed rows", () => {
		const points = forecastRowsToPoints(SYNTHETIC_ROWS);
		const borrowed = points.find(
			(p) => p.imputationMethod === "nowcast_bedroom_borrowed",
		);
		expect(borrowed).toBeDefined();
		expect(borrowed?.lo80).toBeNull();
		expect(borrowed?.hi80).toBeNull();
		expect(borrowed?.lo95).toBeNull();
		expect(borrowed?.hi95).toBeNull();
	});

	it("coerces ds from Date, number-of-days, and bigint into a JS Date", () => {
		const points = forecastRowsToPoints(SYNTHETIC_ROWS);
		// Row 0 (Date), Row 1 (number-of-days), Row 2 (bigint) — all three
		// should land as JS Dates pointing at sensible years.
		for (const p of points) {
			expect(p.ts).toBeInstanceOf(Date);
			const year = p.ts.getUTCFullYear();
			expect(year).toBeGreaterThanOrEqual(2000);
			expect(year).toBeLessThanOrEqual(2100);
		}
	});
});

describe("cpi base period comment", () => {
	it("matches the extractor's source-of-truth (2011-12 = 100)", () => {
		const source = readFileSync(SOURCE_PATH, "utf8");
		expect(source).toContain("base 2011-12 = 100");
	});
});

describe("cpiRowsToPoints", () => {
	const SYNTHETIC_CPI_ROWS: CpiRow[] = [
		{ time_bucket: new Date("2024-01-01"), index_value: 120.5 },
		{ time_bucket: new Date("2024-04-01"), index_value: 121.8 },
		// Number input — days-since-epoch (DuckDB DATE format).
		{ time_bucket: 19905, index_value: 123.2 },
		// bigint input — some Arrow configs hand back bigints.
		{
			time_bucket: BigInt(new Date("2024-10-01").getTime()),
			index_value: 124.7,
		},
	];

	it("preserves input order (SQL ORDER BY upstream guarantees ts-ascending)", () => {
		const points = cpiRowsToPoints(SYNTHETIC_CPI_ROWS);
		expect(points.length).toBe(SYNTHETIC_CPI_ROWS.length);
		for (let i = 1; i < points.length; i++) {
			const prev = points[i - 1];
			const curr = points[i];
			if (prev !== undefined && curr !== undefined) {
				expect(curr.ts.getTime()).toBeGreaterThanOrEqual(prev.ts.getTime());
			}
		}
	});

	it("returns finite index values (base 2011-12 = 100 scale)", () => {
		const points = cpiRowsToPoints(SYNTHETIC_CPI_ROWS);
		for (const p of points) {
			expect(Number.isFinite(p.index)).toBe(true);
			// CPI series should be positive; never negative.
			expect(p.index).toBeGreaterThan(0);
		}
	});

	it("coerces time_bucket from Date / number-of-days / bigint into a JS Date", () => {
		const points = cpiRowsToPoints(SYNTHETIC_CPI_ROWS);
		for (const p of points) {
			expect(p.ts).toBeInstanceOf(Date);
			const year = p.ts.getUTCFullYear();
			expect(year).toBeGreaterThanOrEqual(2000);
			expect(year).toBeLessThanOrEqual(2100);
		}
	});
});

describe("rowsToSeries", () => {
	const obs = (
		dwelling: string,
		bedrooms: string,
		ts: string,
		value: number,
		source_file: string | null = "20230101.parquet",
	): Row => ({
		data_type: "rental",
		dwelling_type: dwelling,
		bedrooms,
		time_bucket: new Date(ts),
		value,
		source_file,
	});

	it("groups rows by (dataType, dwellingType, bedrooms)", () => {
		const series = rowsToSeries([
			obs("house", "all", "2025-06-01", 700),
			obs("house", "all", "2025-09-01", 710),
			obs("unit", "all", "2025-06-01", 500),
		]);
		expect(series.length).toBe(2);
		const house = series.find(
			(s) => s.dwellingType === "house" && s.bedrooms === "all",
		);
		expect(house?.points.length).toBe(2);
		expect(house?.points[0]?.value).toBe(700);
	});

	it("flags a series imputed when every row has the imputed: source prefix", () => {
		const series = rowsToSeries([
			obs(
				"house",
				"all",
				"2025-06-01",
				700,
				"imputed:rollup_rental_dwelling_all",
			),
			obs(
				"house",
				"all",
				"2025-09-01",
				710,
				"imputed:rollup_rental_dwelling_all",
			),
		]);
		expect(series[0]?.imputed).toBe(true);
	});

	it("flags a series NOT imputed if any row is observed", () => {
		// Defensive: one observed row downgrades the whole series. We'd rather
		// under-flag than mis-paint a real observation as synthetic.
		const series = rowsToSeries([
			obs(
				"house",
				"all",
				"2025-06-01",
				700,
				"imputed:rollup_rental_dwelling_all",
			),
			obs("house", "all", "2025-09-01", 710, "20230101.parquet"),
		]);
		expect(series[0]?.imputed).toBe(false);
	});

	it("treats a null source_file as observed", () => {
		const series = rowsToSeries([obs("house", "all", "2025-06-01", 700, null)]);
		expect(series[0]?.imputed).toBe(false);
	});
});
