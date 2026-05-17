import { lazy, Suspense, useEffect, useMemo, useState } from "react";

import { Plot } from "@/lib/plotly";

// Lazy-loaded so the Models tab's panel (and its rental-sales-query
// fetches) only download when the user actually clicks Models. The
// rental/sales/yield code paths stay in the main SuburbPlot chunk and
// don't pay for the model-details tree on every map-side mount.
const ModelDetailsPanel = lazy(() =>
	import("@/components/explorer/ModelDetailsPanel").then((m) => ({
		default: m.ModelDetailsPanel,
	})),
);
import type { RegionSelection } from "@/lib/region";
import {
	type CpiPoint,
	forecastSeriesKey,
	queryCpiSeries,
	queryRegionForecastGrouped,
	queryRegionTimeSeries,
	type SuburbTimeSeries,
} from "@/lib/rental-sales-query";
import { lookupSuburb } from "@/lib/suburb-mappings";
import {
	buildForecastTrace,
	buildImputedBandTrace,
	colorForIndex,
	DEFAULT_INTERVALS,
	recoverSigmaFromForecast,
	seriesColorKey,
	traceLabel,
} from "@/lib/suburb-plot-traces";
import { type OverlayTheme, useOverlayTheme } from "@/lib/theme";
import {
	buildYieldSeries,
	buildYieldTraces,
	type RegionMarketSeries,
} from "@/lib/yield-ratio";

type View = "rental" | "sales" | "yield" | "models";

// Sort key: roll-ups first ("All dwellings"), then by dwelling type, then
// numeric bedrooms ascending. Keeps the legend reading top-to-bottom from
// "headline aggregate" → "specific breakouts".
const traceSortKey = (s: SuburbTimeSeries): [number, string, number] => {
	const isAggregate = s.dwellingType === "all" && s.bedrooms === "all" ? 0 : 1;
	const brNum = s.bedrooms === "all" ? -1 : Number(s.bedrooms);
	return [isAggregate, s.dwellingType, Number.isFinite(brNum) ? brNum : 99];
};

const compareSeries = (a: SuburbTimeSeries, b: SuburbTimeSeries): number => {
	const [a0, a1, a2] = traceSortKey(a);
	const [b0, b1, b2] = traceSortKey(b);
	return a0 - b0 || a1.localeCompare(b1) || a2 - b2;
};

// Map seriesColorKey → palette colour, indexed by sorted position. The same
// map is consumed by buildTraces / buildForecastTrace / buildImputedBandTrace
// so a series's observed line, its imputed-σ fill, and its forecast
// continuation all share one colour. Dash patterns carry the orthogonal
// provenance signal (solid = observed, dot = imputed, longdash = forecast).
const buildColorMap = (subset: SuburbTimeSeries[]): Map<string, string> => {
	const sorted = [...subset].sort(compareSeries);
	return new Map(sorted.map((s, i) => [seriesColorKey(s), colorForIndex(i)]));
};

// Trace builder for the observed/imputed historical lines.
//   - solid (no dash)   when the series is vendor-observed
//   - "dot" (short dot) when the series is one of the four impute classes
// Colour comes from the shared colour map so the forecast continuation,
// observed history, and σ band line up visually as one trace family.
const buildTraces = (
	subset: SuburbTimeSeries[],
	colorMap: Map<string, string>,
) =>
	[...subset].sort(compareSeries).map((s) => {
		const base = traceLabel(s);
		const color = colorMap.get(seriesColorKey(s));
		return {
			x: s.points.map((p) => p.ts),
			y: s.points.map((p) => p.value),
			type: "scatter" as const,
			mode: "lines" as const,
			name: s.imputed ? `${base} · imputed` : base,
			line: {
				...(color ? { color } : {}),
				...(s.imputed ? { dash: "dot" as const } : {}),
			},
		};
	});

// CPI is region-independent — share a single cached promise across every
// SuburbPlot mount. Reusing the same Date objects across mounts also lets
// Plotly's deep-compare bail out on re-render when only the rental/sales
// series changed.
let _cpiPromise: Promise<CpiPoint[]> | null = null;
const getCpi = (): Promise<CpiPoint[]> => {
	if (!_cpiPromise) _cpiPromise = queryCpiSeries();
	return _cpiPromise;
};

// CPI trace for the secondary y-axis. Drawn as a dashed grey line so it
// reads as "reference / context" rather than competing with the primary
// price traces for visual weight. `yaxis: "y2"` binds the series to the
// right-side axis configured in the plot layout below.
const buildCpiTrace = (cpi: ReadonlyArray<CpiPoint>, isDark: boolean) => ({
	x: cpi.map((p) => p.ts),
	y: cpi.map((p) => p.index),
	type: "scatter" as const,
	mode: "lines" as const,
	name: "Melbourne CPI",
	yaxis: "y2" as const,
	line: {
		color: isDark ? "rgb(163 163 163)" : "rgb(115 115 115)", // neutral-400 / 500
		width: 1.5,
		dash: "dash" as const,
	},
	// Match the rental/sales traces' default hover content: date + value.
	// `%{x|%b %Y}` uses plotly's d3-time formatting → "Sep 2025" to
	// match the rental data's natural quarterly label. <extra/> hides
	// the trailing trace-name box plotly otherwise appends.
	hovertemplate: "%{x|%b %Y}<br>CPI %{y:.1f}<extra></extra>",
});

// Default react-lazy export — App imports this via lazy() so the entire
// plotly+series chunk only loads on the first suburb click.
// Identified by SAL_CODE21 (numeric, stable) rather than name (mixed case
// + hyphen-grouped in the source data).
// Plotly layout fragments per theme. Plotly takes raw colour strings, not
// CSS classes, so we feed it from the React-side theme instead of relying
// on Tailwind's `dark:` modifier. Light keeps the original off-white plot
// background that reads cleanly on a white panel; dark uses translucent
// neutral-800 so the plot melts into the dark widget background.
const plotlyTheme = (theme: OverlayTheme) => {
	const isDark = theme === "dark";
	return {
		paper_bgcolor: "rgba(0,0,0,0)",
		plot_bgcolor: isDark ? "rgba(255,255,255,0.04)" : "rgba(255,255,255,0.6)",
		font: { color: isDark ? "rgb(228 228 231)" : "rgb(23 23 23)" }, // neutral-200 / neutral-900
		gridcolor: isDark ? "rgb(64 64 64)" : "rgb(229 229 229)", // neutral-700 / neutral-200
		zerolinecolor: isDark ? "rgb(82 82 82)" : "rgb(163 163 163)", // neutral-600 / neutral-400
	};
};

// `intervals` is a typed prop boundary per the G5 ADR — the map route never
// sets it (default [80, 95] applies); analyst surfaces like the /explore
// pages can pass non-default values, e.g. `[80]` for tighter bands or `[]`
// to suppress them entirely.
//
// `view` pins the chart to one side and hides the rental/sales tab UI; the
// map route omits it (tabbed default) and the /explore RegionDualPlot
// stacks two pinned mounts (one rental, one sales) on the same page.
export default function SuburbPlot({
	region,
	intervals = DEFAULT_INTERVALS,
	view: forcedView,
}: {
	region: RegionSelection;
	intervals?: ReadonlyArray<80 | 95>;
	view?: View;
}) {
	const [series, setSeries] = useState<SuburbTimeSeries[] | null>(null);
	const [cpi, setCpi] = useState<CpiPoint[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [internalView, setInternalView] = useState<View>("rental");
	const view = forcedView ?? internalView;
	const { theme } = useOverlayTheme();

	useEffect(() => {
		setError(null);
		setSeries(null);
		// Run the observed-series and forecast queries in parallel, then merge
		// the forecast bucket onto each series by (dataType, dwellingType,
		// bedrooms). A series with no forecast row in the bake stays at
		// `forecast: undefined` and renders observed-only — matches the
		// fallback the trace builder already expects.
		Promise.all([
			queryRegionTimeSeries(region.kind, region.code),
			queryRegionForecastGrouped(region.kind, region.code).catch(
				(err: unknown) => {
					// Forecasts are an additive overlay — if the forecasts table is
					// missing (pre-bake duckdb), warn but don't fail the chart.
					console.warn("forecast load failed:", err);
					return new Map<
						string,
						ReturnType<(typeof Array.prototype)[number]>
					>();
				},
			),
		])
			.then(([base, forecastsByKey]) => {
				const merged = base.map((s) => ({
					...s,
					forecast: forecastsByKey.get(
						forecastSeriesKey(s.dataType, s.dwellingType, s.bedrooms),
					),
				}));
				setSeries(merged);
			})
			.catch((err: unknown) => {
				setError(err instanceof Error ? err.message : String(err));
			});
	}, [region.kind, region.code]);

	// CPI is region-independent and module-cached — fetched once per
	// session. Failure is non-fatal: the chart degrades to single-axis if
	// CPI doesn't land (e.g. older DuckDB without the cpi table).
	useEffect(() => {
		getCpi()
			.then(setCpi)
			.catch((err: unknown) => {
				console.warn("CPI load failed:", err);
			});
	}, []);

	// Partition once per data load. `useMemo` because the partition feeds
	// directly into Plotly's `data` prop, which deep-compares for re-render.
	const { rental, sales } = useMemo(() => {
		const r: SuburbTimeSeries[] = [];
		const s: SuburbTimeSeries[] = [];
		for (const t of series ?? []) {
			(t.dataType === "rental" ? r : s).push(t);
		}
		return { rental: r, sales: s };
	}, [series]);

	// Derived yield series — one per (dwelling, bedrooms) slice that has
	// BOTH a rental and a sales series. Computed via the pure
	// `buildYieldSeries` helper; the composite qualifier per series
	// drives the dash style (observed/partially imputed/fully imputed/
	// forecast). See docs/GLOSSARY.md § yield_ratio.
	const yields = useMemo(() => {
		const toMarket = (s: SuburbTimeSeries): RegionMarketSeries => ({
			dwellingType: s.dwellingType,
			bedrooms: s.bedrooms,
			imputed: s.imputed,
			points: s.points,
			...(s.forecast
				? {
						forecast: {
							points: s.forecast.map((p) => ({
								ts: p.ts,
								value: p.yHat,
							})),
						},
					}
				: {}),
		});
		return buildYieldSeries(rental.map(toMarket), sales.map(toMarket));
	}, [rental, sales]);

	// Auto-flip to whichever tab actually has data when the suburb changes.
	// e.g. some suburbs have rental-only, some sales-only. Skipped when the
	// view is forced — the dual-plot caller wants the empty side to render
	// its own "no data" placeholder, not silently retarget.
	useEffect(() => {
		if (!series || forcedView !== undefined) return;
		if (internalView === "rental" && rental.length === 0 && sales.length > 0) {
			setInternalView("sales");
		} else if (
			internalView === "sales" &&
			sales.length === 0 &&
			rental.length > 0
		) {
			setInternalView("rental");
		}
	}, [series, internalView, forcedView, rental.length, sales.length]);

	// The `suburb-plot-${view}-ready` testid is the e2e contract: it appears
	// on every terminal state (error, no-region-data, chart, no-view-data)
	// and is absent during loading. The /explore matrix waits on it to know
	// each panel has finished rendering whatever it's going to render.
	if (error) {
		return (
			<div
				data-testid={`suburb-plot-${view}-ready`}
				data-state="error"
				className="px-3 py-2 text-xs text-red-700 dark:text-red-300"
			>
				Query error: {error}
			</div>
		);
	}
	if (!series) {
		return (
			<div className="px-3 py-2 text-xs text-neutral-500 dark:text-neutral-400">
				Loading…
			</div>
		);
	}
	if (series.length === 0) {
		return (
			<div
				data-testid={`suburb-plot-${view}-ready`}
				data-state="empty-region"
				className="px-3 py-2 text-xs text-neutral-500 dark:text-neutral-400"
			>
				No rental/sales rows for this suburb (SAL_CODE21 not found in any
				geospatial_codes group). Some real-estate market areas don't map 1:1
				onto ABS suburb codes.
			</div>
		);
	}

	const activeSeries =
		view === "rental" ? rental : view === "sales" ? sales : [];
	// Shared palette index for this view. A series's observed line, its
	// imputed-σ band, and its forecast continuation all read the same
	// colour out of this map. For yield view: index off the yield series'
	// own (dwelling, bedrooms) so colours stay stable between rental/
	// sales/yield tabs for the same slice.
	const colorMap =
		view === "yield"
			? buildColorMap(
					yields.map(
						(y): SuburbTimeSeries => ({
							dataType: "rental",
							dwellingType: y.dwellingType,
							bedrooms: y.bedrooms,
							imputed: false,
							points: [],
						}),
					),
				)
			: buildColorMap(activeSeries);
	const colorOf = (s: SuburbTimeSeries): string | undefined =>
		colorMap.get(seriesColorKey(s));
	const colorOfSlice = (s: {
		dwellingType: string;
		bedrooms: string;
	}): string | undefined =>
		colorMap.get(
			seriesColorKey({
				dwellingType: s.dwellingType,
				bedrooms: s.bedrooms,
			} as SuburbTimeSeries),
		);
	const dataTraces =
		view === "yield"
			? buildYieldTraces(yields, colorOfSlice)
			: buildTraces(activeSeries, colorMap);
	// Long-dash forecast continuation lines + matching-hue interval bands.
	// Pure-TS construction in suburb-plot-traces.ts so the shape is unit-
	// tested without Plotly (see src/lib/suburb-plot-traces.test.ts).
	const forecastTraces =
		view === "yield"
			? []
			: activeSeries.flatMap((s) =>
					buildForecastTrace(s, intervals, colorOf(s)),
				);
	// ±Z_95·σ fill band over the historical points of any imputed series.
	// σ is the SARIMAX in-sample residual recovered from the same series'
	// smallest-horizon forecast interval — no separate ETL column needed,
	// the bake's existing y_hat_lo_95 / hi_95 already encode it. Rendered
	// BEFORE the data lines so the dotted imputed line paints on top.
	const imputedBands =
		view === "yield"
			? []
			: activeSeries.flatMap((s) =>
					buildImputedBandTrace(
						s,
						recoverSigmaFromForecast(s.forecast),
						colorOf(s),
					),
				);
	// Append the CPI overlay if loaded. Going at the end keeps it as the
	// last legend entry, below the rental/sales series — visually it
	// reads as a "reference annotation" rather than primary data. Skipped
	// on yield view since the dimensionless yield ratio doesn't share an
	// axis with CPI's index scale.
	const traces =
		cpi && cpi.length > 0 && view !== "yield"
			? [
					...imputedBands,
					...dataTraces,
					...forecastTraces,
					buildCpiTrace(cpi, theme === "dark"),
				]
			: [...imputedBands, ...dataTraces, ...forecastTraces];
	const yTitle =
		view === "rental"
			? "Median weekly rent (AUD)"
			: view === "sales"
				? "Median sale price (AUD)"
				: "Gross yield (rent × 52 / sale price)";
	const yTickFormat = view === "yield" ? ".2%" : "$,.0f";

	// Reconciled group label for the active view. The rental_sales source
	// often collapses 2-3 SALs into one rental group (e.g. "North Melbourne-
	// West Melbourne" for codes 21966-22757) while keeping per-SAL sales
	// rows. Surfacing the group label tells the user "you're seeing the
	// rolled-up market rent for this larger area" rather than letting them
	// assume the chart is per-suburb.
	//
	// LGAs are already the largest geographic tier and don't collapse into
	// multi-region groups, so the badge only applies to suburb selections.
	const mapping =
		region.kind === "suburb" ? lookupSuburb(region.code) : undefined;
	const activeGroup = view === "rental" ? mapping?.rental : mapping?.sales;
	const groupLabel = activeGroup?.groupLabel ?? null;
	const showGroupBadge =
		groupLabel != null &&
		mapping?.salName != null &&
		groupLabel.toLowerCase() !== mapping.salName.toLowerCase();

	// Model Details view: reuses the existing ModelDetailsPanel from
	// /explore. Hosted here on the main map panel per the user's "fourth
	// tab" ask so the underlying SARIMAX coefficients + diagnostics are
	// visible from the headline chart, not just the analyst surface.
	if (view === "models") {
		return (
			<div>
				{forcedView === undefined && (
					<ViewTabs
						view={view}
						onChange={setInternalView}
						rentalCount={rental.length}
						salesCount={sales.length}
						yieldCount={yields.length}
					/>
				)}
				<div data-testid="suburb-plot-models-ready" data-state="chart">
					<Suspense
						fallback={
							<div className="px-2 py-4 text-neutral-500 text-xs">
								Loading model details…
							</div>
						}
					>
						<ModelDetailsPanel region={region} />
					</Suspense>
				</div>
			</div>
		);
	}

	return (
		<div>
			{forcedView === undefined && (
				<ViewTabs
					view={view}
					onChange={setInternalView}
					rentalCount={rental.length}
					salesCount={sales.length}
					yieldCount={yields.length}
				/>
			)}
			{showGroupBadge && (
				<p className="mb-1 px-1 text-[11px] text-neutral-500 dark:text-neutral-400">
					Market area:{" "}
					<span className="text-neutral-700 dark:text-neutral-200">
						{groupLabel}
					</span>
					{activeGroup && activeGroup.groupSize > 1 && (
						<span className="ml-1 text-neutral-400 dark:text-neutral-500">
							({activeGroup.groupSize} SALs)
						</span>
					)}
				</p>
			)}
			{traces.length === 0 ? (
				<div
					data-testid={`suburb-plot-${view}-ready`}
					data-state="empty-view"
					className="px-3 py-8 text-center text-xs text-neutral-500 dark:text-neutral-400"
				>
					No {view} data for this suburb.
				</div>
			) : (
				<div data-testid={`suburb-plot-${view}-ready`} data-state="chart">
					<Plot
						data={traces}
						layout={{
							autosize: true,
							// Right margin sized for the vertical legend — needs to fit
							// the longest trace label ("All dwellings", "House · 4 br")
							// plus the swatch. Bottom margin shrinks now that the legend
							// is no longer eating that band.
							// Right margin sized to fit the secondary CPI axis (ticks +
							// title ~50px) plus the legend (~150px) without overlap.
							margin: { l: 56, r: 200, t: 8, b: 32 },
							showlegend: true,
							// Vertical legend pinned to the right of the plot area.
							// `x: 1.02` puts it just outside the chart's right edge;
							// `y: 1` + `yanchor: "top"` aligns it to the top so a long
							// legend grows downward instead of centring (which would
							// make a 2-entry "Sales" view look detached at mid-height).
							legend: {
								orientation: "v",
								// Pushed further right to clear the secondary y-axis
								// ticks + "CPI (2023-24 = 100)" title sitting against the
								// plot area's right edge.
								x: 1.18,
								xanchor: "left",
								y: 1,
								yanchor: "top",
								font: { color: plotlyTheme(theme).font.color },
							},
							xaxis: {
								type: "date",
								gridcolor: plotlyTheme(theme).gridcolor,
								zerolinecolor: plotlyTheme(theme).zerolinecolor,
							},
							yaxis: {
								rangemode: "tozero",
								tickformat: yTickFormat,
								title: { text: yTitle, standoff: 8 },
								gridcolor: plotlyTheme(theme).gridcolor,
								zerolinecolor: plotlyTheme(theme).zerolinecolor,
							},
							// Secondary axis bound to the CPI trace via `yaxis: "y2"`.
							// `overlaying: "y"` shares the chart area; `side: "right"`
							// puts ticks on the opposite edge. No `rangemode: tozero`
							// here — CPI is bounded ~47 → ~102 and forcing zero would
							// crush its visual range against the bottom of the chart.
							yaxis2: {
								overlaying: "y",
								side: "right",
								title: { text: "CPI (2023-24 = 100)", standoff: 8 },
								showgrid: false,
								tickfont: { color: plotlyTheme(theme).font.color },
								titlefont: { color: plotlyTheme(theme).font.color },
							},
							paper_bgcolor: plotlyTheme(theme).paper_bgcolor,
							plot_bgcolor: plotlyTheme(theme).plot_bgcolor,
							font: { size: 11, color: plotlyTheme(theme).font.color },
						}}
						config={{ displaylogo: false, responsive: true }}
						useResizeHandler
						style={{ width: "100%", height: 280 }}
					/>
				</div>
			)}
		</div>
	);
}

const ViewTabs = ({
	view,
	onChange,
	rentalCount,
	salesCount,
	yieldCount,
}: {
	view: View;
	onChange: (v: View) => void;
	rentalCount: number;
	salesCount: number;
	yieldCount: number;
}) => {
	const tab = (target: View, label: string, count: number) => {
		const active = view === target;
		const disabled = count === 0;
		return (
			<button
				type="button"
				onClick={() => !disabled && onChange(target)}
				aria-pressed={active}
				disabled={disabled}
				className={[
					"rounded-md px-2.5 py-1 text-xs transition-colors",
					active
						? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
						: disabled
							? "cursor-not-allowed text-neutral-400 dark:text-neutral-600"
							: "cursor-pointer text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800",
				].join(" ")}
			>
				{label}
				<span
					className={`ml-1.5 tabular-nums text-[10px] ${
						active
							? "text-neutral-300 dark:text-neutral-600"
							: "text-neutral-400 dark:text-neutral-500"
					}`}
				>
					{count}
				</span>
			</button>
		);
	};

	return (
		<div
			className="mb-1 flex items-center gap-1 px-1"
			role="tablist"
			aria-label="Chart view"
		>
			{tab("rental", "Rental", rentalCount)}
			{tab("sales", "Sales", salesCount)}
			{tab("yield", "Yield", yieldCount)}
			{/* Models tab is always enabled — it queries its own data and
			    the panel handles "no model" rendering itself. Pass count=1
			    so the tab button doesn't disable. */}
			{tab("models", "Models", 1)}
		</div>
	);
};
