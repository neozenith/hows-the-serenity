// Project-composed Plotly bundle. The pre-built `plotly.js-cartesian-dist-min`
// dist is locked to cartesian traces (scatter / bar / etc.) — no sankey,
// no treemap, no register() API to add them. We don't want the 3 MB full
// `plotly.js-dist-min`, so we compose our own from `plotly.js/lib/core`
// plus the specific trace modules we use.
//
// Every chart in the app — SuburbPlot's CPI/forecast scatter on /explore,
// the ClusterSankey on the dendrogram pages — imports its Plotly through
// this file so we never end up with two Plotly copies in the bundle.

import Plotly from "plotly.js/lib/core";
import sankey from "plotly.js/lib/sankey";
import scatter from "plotly.js/lib/scatter";
import treemap from "plotly.js/lib/treemap";
import type { ComponentType, CSSProperties } from "react";
import * as FactoryMod from "react-plotly.js/factory";

// Register the trace modules on the core Plotly object before anything else
// imports `getPlotly()`. Modules are idempotent — calling register twice
// with the same module is a no-op.
Plotly.register([scatter, sankey, treemap]);

type PlotProps = {
	data: unknown[];
	layout?: unknown;
	config?: unknown;
	useResizeHandler?: boolean;
	style?: CSSProperties;
	className?: string;
};

type PlotlyFactory = (P: unknown) => ComponentType<PlotProps>;

// Vite's esbuild interop double-wraps `react-plotly.js/factory`: the
// namespace is `{ default: { default: factoryFn } }` because the package's
// compiled CJS already has `__esModule: true` + `exports.default = fn`, and
// Vite then re-wraps that whole `module.exports` under another `default`.
// Recurse into `.default` chains until the predicate matches.
const findInDefaults = <T>(
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

const createPlotlyComponent = findInDefaults<PlotlyFactory>(
	FactoryMod,
	(v) => typeof v === "function",
);

export const Plot = createPlotlyComponent(Plotly);
export { Plotly };
