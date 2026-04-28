import * as PlotlyMod from "plotly.js-cartesian-dist-min";
import {
	type ComponentType,
	type CSSProperties,
	useEffect,
	useMemo,
	useState,
} from "react";
import * as FactoryMod from "react-plotly.js/factory";
import {
	queryRegionTimeSeries,
	type SuburbTimeSeries,
} from "@/lib/rental-sales-query";
import { lookupSuburb } from "@/lib/suburb-mappings";
import { type OverlayTheme, useOverlayTheme } from "@/lib/theme";
import type { RegionSelection } from "./SuburbPlotPanel";

// Plotly's full bundle is ~3 MB; cartesian-dist-min is ~700 KB and includes
// the scatter/line traces we need. Pair with react-plotly.js via its factory
// so we don't pull the full plotly.js dist that the default react-plotly.js
// import would drag in.
//
// Both deps are CJS/UMD. Vite's esbuild interop hands them back as namespace
// objects with the real value on `.default`, so a plain `import x from …`
// resolves to the namespace, not the function — calling it then throws
// "createPlotlyComponent is not a function". Unwrap explicitly so the
// runtime shape matches the type.
type PlotProps = {
	data: unknown[];
	layout?: unknown;
	config?: unknown;
	useResizeHandler?: boolean;
	style?: CSSProperties;
};
type PlotlyFactory = (P: unknown) => ComponentType<PlotProps>;

// Vite's esbuild interop double-wraps `react-plotly.js/factory`: the namespace
// is `{ default: { default: factoryFn } }` because the package's compiled CJS
// already has `__esModule: true` + `exports.default = fn`, and Vite then
// re-wraps that whole `module.exports` under another `default`. Plotly's UMD
// is single-wrapped (top-level is the Plotly object). Recurse into `.default`
// chains until we find the predicate match — covers both shapes safely.
const findInDefaults = <T,>(
	start: unknown,
	pred: (v: unknown) => boolean,
): T => {
	let cur: unknown = start;
	for (let i = 0; i < 4 && cur != null; i++) {
		if (pred(cur)) return cur as T;
		cur = (cur as { default?: unknown }).default;
	}
	throw new Error("findInDefaults: no value matched predicate");
};

const Plotly = findInDefaults<unknown>(
	PlotlyMod,
	(v) => typeof v === "object" && v !== null && "newPlot" in v,
);
const createPlotlyComponent = findInDefaults<PlotlyFactory>(
	FactoryMod,
	(v) => typeof v === "function",
);
const Plot = createPlotlyComponent(Plotly);

type View = "rental" | "sales";

const capitalize = (s: string): string =>
	s.length === 0 ? s : `${s[0]?.toUpperCase() ?? ""}${s.slice(1)}`;

// Compose a human-readable trace name. The source data carries a coarse
// `(dwellingType, bedrooms)` pair where either axis can be "all" meaning
// "rolled-up across this dimension". Map the four cases to readable labels
// instead of e.g. raw "house/all" strings.
const traceLabel = (s: SuburbTimeSeries): string => {
	const dt = s.dwellingType;
	const br = s.bedrooms;
	if (dt === "all" && br === "all") return "All dwellings";
	if (br === "all") return capitalize(dt);
	if (dt === "all") return `All · ${br} br`;
	return `${capitalize(dt)} · ${br} br`;
};

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

const buildTraces = (subset: SuburbTimeSeries[]) =>
	[...subset].sort(compareSeries).map((s) => ({
		x: s.points.map((p) => p.ts),
		y: s.points.map((p) => p.value),
		type: "scatter" as const,
		mode: "lines" as const,
		name: traceLabel(s),
	}));

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

export default function SuburbPlot({ region }: { region: RegionSelection }) {
	const [series, setSeries] = useState<SuburbTimeSeries[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [view, setView] = useState<View>("rental");
	const { theme } = useOverlayTheme();

	useEffect(() => {
		setError(null);
		setSeries(null);
		queryRegionTimeSeries(region.kind, region.code)
			.then(setSeries)
			.catch((err: unknown) => {
				setError(err instanceof Error ? err.message : String(err));
			});
	}, [region.kind, region.code]);

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

	// Auto-flip to whichever tab actually has data when the suburb changes.
	// e.g. some suburbs have rental-only, some sales-only.
	useEffect(() => {
		if (!series) return;
		if (view === "rental" && rental.length === 0 && sales.length > 0) {
			setView("sales");
		} else if (view === "sales" && sales.length === 0 && rental.length > 0) {
			setView("rental");
		}
	}, [series, view, rental.length, sales.length]);

	if (error) {
		return (
			<div className="px-3 py-2 text-xs text-red-700 dark:text-red-300">
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
			<div className="px-3 py-2 text-xs text-neutral-500 dark:text-neutral-400">
				No rental/sales rows for this suburb (SAL_CODE21 not found in any
				geospatial_codes group). Some real-estate market areas don't map 1:1
				onto ABS suburb codes.
			</div>
		);
	}

	const activeSeries = view === "rental" ? rental : sales;
	const traces = buildTraces(activeSeries);
	const yTitle =
		view === "rental" ? "Median weekly rent (AUD)" : "Median sale price (AUD)";

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

	return (
		<div>
			<ViewTabs
				view={view}
				onChange={setView}
				rentalCount={rental.length}
				salesCount={sales.length}
			/>
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
				<div className="px-3 py-8 text-center text-xs text-neutral-500 dark:text-neutral-400">
					No {view} data for this suburb.
				</div>
			) : (
				<Plot
					data={traces}
					layout={{
						autosize: true,
						// Right margin sized for the vertical legend — needs to fit
						// the longest trace label ("All dwellings", "House · 4 br")
						// plus the swatch. Bottom margin shrinks now that the legend
						// is no longer eating that band.
						margin: { l: 56, r: 150, t: 8, b: 32 },
						showlegend: true,
						// Vertical legend pinned to the right of the plot area.
						// `x: 1.02` puts it just outside the chart's right edge;
						// `y: 1` + `yanchor: "top"` aligns it to the top so a long
						// legend grows downward instead of centring (which would
						// make a 2-entry "Sales" view look detached at mid-height).
						legend: {
							orientation: "v",
							x: 1.02,
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
							tickformat: "$,.0f",
							title: { text: yTitle, standoff: 8 },
							gridcolor: plotlyTheme(theme).gridcolor,
							zerolinecolor: plotlyTheme(theme).zerolinecolor,
						},
						paper_bgcolor: plotlyTheme(theme).paper_bgcolor,
						plot_bgcolor: plotlyTheme(theme).plot_bgcolor,
						font: { size: 11, color: plotlyTheme(theme).font.color },
					}}
					config={{ displaylogo: false, responsive: true }}
					useResizeHandler
					style={{ width: "100%", height: 280 }}
				/>
			)}
		</div>
	);
}

const ViewTabs = ({
	view,
	onChange,
	rentalCount,
	salesCount,
}: {
	view: View;
	onChange: (v: View) => void;
	rentalCount: number;
	salesCount: number;
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
		</div>
	);
};
