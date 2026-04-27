import Plotly from "plotly.js-cartesian-dist-min";
import { useEffect, useState } from "react";
import createPlotlyComponent from "react-plotly.js/factory";
import {
	querySuburbTimeSeries,
	type SuburbTimeSeries,
} from "@/lib/rental-sales-query";

// Plotly's full bundle is ~3 MB; cartesian-dist-min is ~700 KB and includes
// the scatter/line traces we need. Pair with react-plotly.js via its factory
// so we don't pull the full plotly.js dist that the default react-plotly.js
// import would drag in.
const Plot = createPlotlyComponent(Plotly);

// Default react-lazy export — App imports this via lazy() so the entire
// plotly+series chunk only loads on the first suburb click.
// Identified by SAL_CODE21 (numeric, stable) rather than name (mixed case
// + hyphen-grouped in the source data).
export default function SuburbPlot({ salCode }: { salCode: string }) {
	const [series, setSeries] = useState<SuburbTimeSeries[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		setError(null);
		setSeries(null);
		querySuburbTimeSeries(salCode)
			.then(setSeries)
			.catch((err: unknown) => {
				setError(err instanceof Error ? err.message : String(err));
			});
	}, [salCode]);

	if (error) {
		return (
			<div className="px-3 py-2 text-xs text-red-700">Query error: {error}</div>
		);
	}
	if (!series) {
		return <div className="px-3 py-2 text-xs text-neutral-500">Loading…</div>;
	}
	if (series.length === 0) {
		return (
			<div className="px-3 py-2 text-xs text-neutral-500">
				No rental/sales rows for this suburb (SAL_CODE21 not found in any
				geospatial_codes group). Some real-estate market areas don't map 1:1
				onto ABS suburb codes.
			</div>
		);
	}

	// For chunk B we render the rolled-up (dwelling_type='all', bedrooms='all')
	// rental + sales series only. Chunk C may broaden this to per-bedrooms /
	// per-dwelling-type traces.
	const focused = series.filter(
		(s) => s.dwellingType === "all" && s.bedrooms === "all",
	);
	const renderable = focused.length > 0 ? focused : series.slice(0, 6);

	const traces = renderable.map((s) => ({
		x: s.points.map((p) => p.ts),
		y: s.points.map((p) => p.value),
		type: "scatter" as const,
		mode: "lines" as const,
		name: `${s.dataType} · ${s.dwellingType}/${s.bedrooms}`,
	}));

	return (
		<Plot
			data={traces}
			layout={{
				autosize: true,
				margin: { l: 48, r: 12, t: 8, b: 32 },
				showlegend: true,
				legend: { orientation: "h", y: -0.18 },
				xaxis: { type: "date" },
				yaxis: { rangemode: "tozero", tickformat: "$,.0f" },
				paper_bgcolor: "rgba(0,0,0,0)",
				plot_bgcolor: "rgba(255,255,255,0.6)",
				font: { size: 11 },
			}}
			config={{ displaylogo: false, responsive: true }}
			useResizeHandler
			style={{ width: "100%", height: 260 }}
		/>
	);
}
