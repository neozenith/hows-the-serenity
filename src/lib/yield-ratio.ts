// Pure helpers for the derived `yield_ratio` market — the third trace
// family on the SuburbPlot + RegionDualPlot (alongside rental + sales).
//
// Per the project's ubiquitous-language glossary (docs/GLOSSARY.md):
//
//   yield_ratio = (rental_weekly × 52) / sale_price
//
//   Composite source qualifier:
//     - observed:          both inputs are observed
//     - partially_imputed: exactly one input is imputed
//     - fully_imputed:     both inputs are imputed
//     - forecast:          either input is from the forecasts table
//
// All math + classification is pure so it's unit-tested without
// instantiating DuckDB or Plotly.

export type SourceQualifier = "observed" | "imputed" | "forecast";

export type YieldQualifier =
	| "observed"
	| "partially_imputed"
	| "fully_imputed"
	| "forecast";

// Composite-qualifier rules — keep them in one place so the UI legend,
// the trace colourer, and the lineage docs all share the same truth.
export const composeYieldQualifier = (
	rentalQualifier: SourceQualifier,
	salesQualifier: SourceQualifier,
): YieldQualifier => {
	// Forecast wins outright — once any input is a forecast, the yield is
	// forecast-grade, regardless of whether the OTHER input is observed
	// or imputed.
	if (rentalQualifier === "forecast" || salesQualifier === "forecast") {
		return "forecast";
	}
	const imputedCount =
		(rentalQualifier === "imputed" ? 1 : 0) +
		(salesQualifier === "imputed" ? 1 : 0);
	if (imputedCount === 2) return "fully_imputed";
	if (imputedCount === 1) return "partially_imputed";
	return "observed";
};

// Annualised rental yield. Rental medians ship as weekly $; multiply by
// 52 to annualise, divide by the matching annual sales median. Result is
// dimensionless (often expressed as % — caller can ×100 for display).
export const yieldRatio = (rentalWeekly: number, salePrice: number): number => {
	if (salePrice <= 0) return Number.NaN;
	return (rentalWeekly * 52) / salePrice;
};

// Pairing layer: rental is quarterly, sales is annual. For each annual
// sales bucket at year Y, find the rental quarter that lands in the
// SAME year and pair them. If multiple rental quarters land in year Y
// (typical: 4), take the LAST one — closest to the year-end snapshot
// the vendor's annual sale aggregate represents.
//
// Returns one paired record per sales bucket that has a matching
// rental quarter. Sales buckets without a same-year rental are dropped
// (no yield computable). Rental quarters without a matching sales year
// are also dropped — yields can't exist without a denominator.
export type PointWithQualifier = {
	ts: Date;
	value: number;
};

export type PairedRentalSales = {
	ts: Date;
	rentalWeekly: number;
	salePrice: number;
};

// Top-level series-pairing API: take the rental + sales arrays the
// SuburbPlot already loads and emit one YieldSeries per (dwelling,
// bedrooms) slice present in BOTH. Per-series qualifier composes from
// the rental.imputed × sales.imputed flags (so a single annual sales
// imputed input yields a fully-imputed yield series, etc).
//
// Forecast points are an additive overlay: any forecast period where
// BOTH sides have a forecast row contributes a forecast yield point,
// classified `forecast` regardless of the underlying input qualifiers.

export type RegionMarketSeries = {
	dwellingType: string;
	bedrooms: string;
	imputed: boolean;
	points: ReadonlyArray<{ ts: Date; value: number }>;
	// Optional forecast bucket — mirror of the SuburbTimeSeries.forecast
	// shape. Each forecast point carries y_hat (point estimate) here.
	forecast?: { points: ReadonlyArray<{ ts: Date; value: number }> };
};

export type YieldPoint = {
	ts: Date;
	value: number;
	qualifier: YieldQualifier;
};

export type YieldSeries = {
	dwellingType: string;
	bedrooms: string;
	qualifier: YieldQualifier; // applies to the OBSERVED-history portion
	points: YieldPoint[]; // observed + forecast points, sorted
};

const sliceKey = (s: { dwellingType: string; bedrooms: string }): string =>
	`${s.dwellingType}|${s.bedrooms}`;

export const buildYieldSeries = (
	rental: ReadonlyArray<RegionMarketSeries>,
	sales: ReadonlyArray<RegionMarketSeries>,
): YieldSeries[] => {
	const rentalByKey = new Map(rental.map((s) => [sliceKey(s), s]));
	const out: YieldSeries[] = [];
	for (const sl of sales) {
		const rentalSlice = rentalByKey.get(sliceKey(sl));
		if (!rentalSlice) continue;
		const composedQualifier = composeYieldQualifier(
			rentalSlice.imputed ? "imputed" : "observed",
			sl.imputed ? "imputed" : "observed",
		);
		const histPairs = pairAnnualBuckets(rentalSlice.points, sl.points);
		const histPoints: YieldPoint[] = histPairs.map((p) => ({
			ts: p.ts,
			value: yieldRatio(p.rentalWeekly, p.salePrice),
			qualifier: composedQualifier,
		}));
		// Forecast continuation: only if BOTH sides have forecast buckets.
		const fcPairs =
			rentalSlice.forecast && sl.forecast
				? pairAnnualBuckets(rentalSlice.forecast.points, sl.forecast.points)
				: [];
		const fcPoints: YieldPoint[] = fcPairs.map((p) => ({
			ts: p.ts,
			value: yieldRatio(p.rentalWeekly, p.salePrice),
			qualifier: "forecast",
		}));
		const points = [...histPoints, ...fcPoints].sort(
			(a, b) => a.ts.getTime() - b.ts.getTime(),
		);
		if (points.length === 0) continue;
		out.push({
			dwellingType: sl.dwellingType,
			bedrooms: sl.bedrooms,
			qualifier: composedQualifier,
			points,
		});
	}
	return out;
};

// Plotly trace builder for the yield-ratio view. Returns one trace per
// (dwelling, bedrooms) yield series with dash pattern keyed off the
// composite qualifier:
//   observed         → solid
//   partially_imputed → dash
//   fully_imputed     → dot
//   forecast portion  → longdash (mirrors how rental/sales forecasts
//                                 render in suburb-plot-traces.ts)
//
// `colorFor` is the same colour-keyed map the rental/sales traces use,
// so a series's house/3br yield line shares the hue of its house/3br
// rental + sales lines — visual reinforcement that they're the same
// underlying signal in a different unit.
const dashFor = (q: YieldQualifier): "solid" | "dash" | "dot" | "longdash" => {
	switch (q) {
		case "observed":
			return "solid";
		case "partially_imputed":
			return "dash";
		case "fully_imputed":
			return "dot";
		case "forecast":
			return "longdash";
	}
};

export type YieldPlotlyTrace = {
	x: Date[];
	y: number[];
	type: "scatter";
	mode: "lines";
	name: string;
	line: { color?: string; dash: "solid" | "dash" | "dot" | "longdash" };
};

export const buildYieldTraces = (
	yields: ReadonlyArray<YieldSeries>,
	colorFor: (s: {
		dwellingType: string;
		bedrooms: string;
	}) => string | undefined,
): YieldPlotlyTrace[] => {
	const out: YieldPlotlyTrace[] = [];
	for (const s of yields) {
		// Split into observed/imputed portion vs forecast portion so each
		// dash style draws as a separate trace (plotly can't switch dash
		// mid-line).
		const histPoints = s.points.filter((p) => p.qualifier !== "forecast");
		const fcPoints = s.points.filter((p) => p.qualifier === "forecast");
		const color = colorFor(s);
		const label = `${s.dwellingType === "all" ? "All dwellings" : `${s.dwellingType[0]?.toUpperCase()}${s.dwellingType.slice(1)} · ${s.bedrooms} br`}`;
		if (histPoints.length > 0) {
			out.push({
				x: histPoints.map((p) => p.ts),
				y: histPoints.map((p) => p.value),
				type: "scatter",
				mode: "lines",
				name: `${label}${s.qualifier === "observed" ? "" : ` · ${s.qualifier.replace("_", " ")}`}`,
				line: { ...(color ? { color } : {}), dash: dashFor(s.qualifier) },
			});
		}
		if (fcPoints.length > 0) {
			out.push({
				x: fcPoints.map((p) => p.ts),
				y: fcPoints.map((p) => p.value),
				type: "scatter",
				mode: "lines",
				name: `${label} · forecast`,
				line: { ...(color ? { color } : {}), dash: dashFor("forecast") },
			});
		}
	}
	return out;
};

export const pairAnnualBuckets = (
	rental: ReadonlyArray<PointWithQualifier>,
	sales: ReadonlyArray<PointWithQualifier>,
): PairedRentalSales[] => {
	// Index rental quarters by year, retaining the latest-ts per year so
	// the pairing always lands on the year-end-closest quarter.
	const latestRentalByYear = new Map<number, PointWithQualifier>();
	for (const r of rental) {
		const y = r.ts.getUTCFullYear();
		const existing = latestRentalByYear.get(y);
		if (!existing || r.ts.getTime() > existing.ts.getTime()) {
			latestRentalByYear.set(y, r);
		}
	}
	const out: PairedRentalSales[] = [];
	for (const s of sales) {
		const y = s.ts.getUTCFullYear();
		const r = latestRentalByYear.get(y);
		if (!r) continue;
		out.push({ ts: s.ts, rentalWeekly: r.value, salePrice: s.value });
	}
	// Stable chronological order so the trace points draw monotonically.
	out.sort((a, b) => a.ts.getTime() - b.ts.getTime());
	return out;
};
