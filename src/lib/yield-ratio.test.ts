// Unit tests for the yield-ratio pure helpers.

import { describe, expect, it } from "vitest";

import {
	buildYieldSeries,
	buildYieldTraces,
	composeYieldQualifier,
	pairAnnualBuckets,
	type RegionMarketSeries,
	type YieldSeries,
	yieldRatio,
} from "@/lib/yield-ratio";

describe("composeYieldQualifier", () => {
	it("returns 'observed' when both inputs are observed", () => {
		expect(composeYieldQualifier("observed", "observed")).toBe("observed");
	});

	it("returns 'partially_imputed' when exactly one input is imputed", () => {
		expect(composeYieldQualifier("imputed", "observed")).toBe(
			"partially_imputed",
		);
		expect(composeYieldQualifier("observed", "imputed")).toBe(
			"partially_imputed",
		);
	});

	it("returns 'fully_imputed' when both inputs are imputed", () => {
		expect(composeYieldQualifier("imputed", "imputed")).toBe("fully_imputed");
	});

	it("returns 'forecast' whenever any input is a forecast — overrides all other classifications", () => {
		// Forecast + anything else still classifies the composite as forecast,
		// because once the bake's downstream of any forecast input, the
		// quality fidelity is forecast-grade.
		expect(composeYieldQualifier("forecast", "observed")).toBe("forecast");
		expect(composeYieldQualifier("observed", "forecast")).toBe("forecast");
		expect(composeYieldQualifier("forecast", "imputed")).toBe("forecast");
		expect(composeYieldQualifier("imputed", "forecast")).toBe("forecast");
		expect(composeYieldQualifier("forecast", "forecast")).toBe("forecast");
	});
});

describe("buildYieldTraces", () => {
	const d = (iso: string): Date => new Date(iso);
	const ys: YieldSeries = {
		dwellingType: "house",
		bedrooms: "3",
		qualifier: "observed",
		points: [
			{ ts: d("2022-12-31"), value: 0.05, qualifier: "observed" },
			{ ts: d("2025-12-31"), value: 0.06, qualifier: "forecast" },
		],
	};

	it("splits each yield series into observed + forecast traces so dash styles render correctly", () => {
		const traces = buildYieldTraces([ys], () => "#abcdef");
		expect(traces).toHaveLength(2);
		const fc = traces.find((t) => t.name.includes("forecast"));
		const hist = traces.find((t) => !t.name.includes("forecast"));
		expect(hist?.line.dash).toBe("solid");
		expect(fc?.line.dash).toBe("longdash");
	});

	it("emits the partial/full imputed qualifier in the trace name when applicable", () => {
		const partial: YieldSeries = { ...ys, qualifier: "partially_imputed" };
		const traces = buildYieldTraces([partial], () => undefined);
		expect(traces[0]?.name).toMatch(/partially imputed/);
		expect(traces[0]?.line.dash).toBe("dash");
	});

	it("propagates the colorFor map so yield + rental + sales share a hue per (dwelling, bedrooms)", () => {
		const traces = buildYieldTraces([ys], () => "#123456");
		for (const t of traces) expect(t.line.color).toBe("#123456");
	});
});

describe("buildYieldSeries", () => {
	const d = (iso: string): Date => new Date(iso);

	const mkRental = (
		dw: string,
		br: string,
		imputed: boolean,
		quarters: Array<[string, number]>,
	): RegionMarketSeries => ({
		dwellingType: dw,
		bedrooms: br,
		imputed,
		points: quarters.map(([iso, v]) => ({ ts: d(iso), value: v })),
	});

	const mkSales = (
		dw: string,
		br: string,
		imputed: boolean,
		years: Array<[string, number]>,
		forecast?: Array<[string, number]>,
	): RegionMarketSeries => ({
		dwellingType: dw,
		bedrooms: br,
		imputed,
		points: years.map(([iso, v]) => ({ ts: d(iso), value: v })),
		...(forecast
			? {
					forecast: {
						points: forecast.map(([iso, v]) => ({ ts: d(iso), value: v })),
					},
				}
			: {}),
	});

	it("emits one yield series per (dwelling, bedrooms) slice present in BOTH rental and sales", () => {
		const rental = [
			mkRental("house", "3", false, [["2022-12-01", 500]]),
			mkRental("unit", "2", false, [["2022-12-01", 400]]),
		];
		const sales = [
			mkSales("house", "3", false, [["2022-12-31", 520_000]]),
			// no unit/2 sales — no yield series emitted for it
		];
		const out = buildYieldSeries(rental, sales);
		expect(out).toHaveLength(1);
		expect(out[0]?.dwellingType).toBe("house");
		expect(out[0]?.bedrooms).toBe("3");
		expect(out[0]?.qualifier).toBe("observed");
		expect(out[0]?.points[0]?.value).toBeCloseTo(0.05, 6); // 500*52/520k
	});

	it("propagates 'partially_imputed' qualifier when only one side is imputed", () => {
		const rental = [mkRental("house", "3", true, [["2022-12-01", 500]])];
		const sales = [mkSales("house", "3", false, [["2022-12-31", 520_000]])];
		const out = buildYieldSeries(rental, sales);
		expect(out[0]?.qualifier).toBe("partially_imputed");
		expect(out[0]?.points[0]?.qualifier).toBe("partially_imputed");
	});

	it("emits forecast points when BOTH sides have forecast buckets", () => {
		const rental: RegionMarketSeries = {
			dwellingType: "house",
			bedrooms: "3",
			imputed: false,
			points: [{ ts: d("2022-12-01"), value: 500 }],
			forecast: { points: [{ ts: d("2025-12-01"), value: 600 }] },
		};
		const sales = mkSales(
			"house",
			"3",
			false,
			[["2022-12-31", 520_000]],
			[["2025-12-31", 600_000]],
		);
		const out = buildYieldSeries([rental], [sales]);
		expect(out[0]?.points).toHaveLength(2);
		const fcPoint = out[0]?.points.find((p) => p.qualifier === "forecast");
		expect(fcPoint).toBeDefined();
		expect(fcPoint?.value).toBeCloseTo(0.052, 3); // 600*52/600k
	});
});

describe("pairAnnualBuckets", () => {
	const d = (iso: string): Date => new Date(iso);

	it("matches a quarterly rental year to an annual sales year and picks the latest quarter", () => {
		// 4 rental quarters in 2022; one annual sales point in 2022 →
		// pair sales[2022] with rental[Q4 2022].
		const rental = [
			{ ts: d("2022-03-01"), value: 400 },
			{ ts: d("2022-06-01"), value: 420 },
			{ ts: d("2022-09-01"), value: 430 },
			{ ts: d("2022-12-01"), value: 450 }, // latest in 2022 — picked
		];
		const sales = [{ ts: d("2022-12-31"), value: 500_000 }];
		const out = pairAnnualBuckets(rental, sales);
		expect(out).toHaveLength(1);
		expect(out[0]?.rentalWeekly).toBe(450);
		expect(out[0]?.salePrice).toBe(500_000);
	});

	it("drops sales buckets with no same-year rental quarter", () => {
		const rental = [{ ts: d("2021-12-01"), value: 400 }];
		const sales = [
			{ ts: d("2021-12-31"), value: 400_000 }, // has 2021 rental
			{ ts: d("2023-12-31"), value: 480_000 }, // no 2023 rental
		];
		expect(pairAnnualBuckets(rental, sales)).toHaveLength(1);
	});

	it("emits one pair per sales year, even with multiple sales years", () => {
		const rental = [
			{ ts: d("2020-12-01"), value: 380 },
			{ ts: d("2021-12-01"), value: 400 },
			{ ts: d("2022-12-01"), value: 420 },
		];
		const sales = [
			{ ts: d("2020-12-31"), value: 380_000 },
			{ ts: d("2021-12-31"), value: 410_000 },
			{ ts: d("2022-12-31"), value: 450_000 },
		];
		const out = pairAnnualBuckets(rental, sales);
		expect(out.map((p) => p.ts.getUTCFullYear())).toEqual([2020, 2021, 2022]);
	});

	it("sorts paired records chronologically regardless of input order", () => {
		const rental = [
			{ ts: d("2022-12-01"), value: 420 },
			{ ts: d("2020-12-01"), value: 380 },
		];
		const sales = [
			{ ts: d("2022-12-31"), value: 450_000 },
			{ ts: d("2020-12-31"), value: 380_000 },
		];
		const out = pairAnnualBuckets(rental, sales);
		expect(out.map((p) => p.ts.getUTCFullYear())).toEqual([2020, 2022]);
	});
});

describe("yieldRatio", () => {
	it("computes (rent_weekly × 52) / sale_price for a known synthetic pair", () => {
		// $500/wk rent × 52 = $26k/yr annual; $520k sale → 0.05 = 5% yield.
		expect(yieldRatio(500, 520_000)).toBeCloseTo(0.05, 6);
	});

	it("returns NaN on a non-positive sale price (defensive division-by-zero)", () => {
		expect(yieldRatio(500, 0)).toBeNaN();
		expect(yieldRatio(500, -1)).toBeNaN();
	});
});
