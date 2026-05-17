// End-to-end gate for the spec's headline goal (G5): the user clicks a
// SAL on the map and sees forecast traces rendered on the Plotly chart.
//
// This is the single test that catches the failure mode flagged by the
// `/escalators-not-stairs` exchange — "all 40 tickets green but the chart
// shows no forecast data because the bake never ran on real data".
//
// We assert THREE things, all read off the live Plotly trace array:
//   1. The chart has at least one trace whose name contains "forecast"
//   2. That trace has `line.dash === "longdash"` (the long-dash forecast visual)
//   3. At least one interval-band trace exists (fill style)
//
// We do NOT assert specific row counts — the bake's row count depends on
// data freshness; that's covered by the bake-side post-conditions. This
// spec answers "does the user-visible chain deliver forecasts at all".

import { expect, test } from "@playwright/test";

// North Melbourne — same target as suburb-click.spec.ts. Has rental data
// (so the forecast table should have a populated row for it).
const TARGET_NAME = "North Melbourne";
const TARGET_CODE = "21966";

interface PlotlyTrace {
	name?: string;
	line?: { dash?: string; width?: number };
	fill?: string;
	mode?: string;
	type?: string;
}

test.describe("Forecast traces on the SuburbPlot", () => {
	test("clicking a SAL renders forecast traces with dashed styling", async ({
		page,
	}) => {
		await page.goto("/");

		await page.waitForFunction(
			() => (document.getElementById("root")?.children.length ?? 0) > 0,
			{ timeout: 15_000 },
		);

		await page.waitForFunction(
			() =>
				typeof (window as unknown as Record<string, unknown>)
					.__htsSelectRegion === "function",
			{ timeout: 10_000 },
		);

		await page
			.waitForLoadState("networkidle", { timeout: 15_000 })
			.catch(() => {});

		// Drive selection programmatically (deck.gl picking flake — see
		// suburb-click.spec.ts comment).
		await page.evaluate(
			([name, code]) => {
				const fn = (window as unknown as Record<string, unknown>)
					.__htsSelectRegion as
					| ((sel: {
							kind: "suburb" | "lga";
							name: string;
							code: string;
					  }) => void)
					| undefined;
				fn?.({ kind: "suburb", name: name as string, code: code as string });
			},
			[TARGET_NAME, TARGET_CODE],
		);

		// Plot panel + chart SVG must render before we can inspect traces.
		// Pinned to an aside containing an h2 — only SuburbPlotPanel matches.
		// See suburb-click.spec.ts comment for the ControlPanel hijack story.
		const panel = page.locator('aside:has(h2:has-text("SAL"))').first();
		await panel.waitFor({ state: "visible", timeout: 30_000 });
		await panel.locator(".main-svg").first().waitFor({
			state: "visible",
			// 90s (up from 60s) — see suburb-click.spec.ts comment; same cause.
			timeout: 90_000,
		});

		// Pull Plotly's live data array off the chart element. Plotly stores
		// its current trace list on `.data` of the root container (the element
		// with class `.js-plotly-plot`).
		const traces = await page.evaluate<PlotlyTrace[]>(() => {
			const plot = document.querySelector(".js-plotly-plot") as
				| (HTMLElement & { data?: PlotlyTrace[] })
				| null;
			return plot?.data ?? [];
		});

		// Diagnostic dump on failure — without this the assertion is a black box.
		test.info().annotations.push({
			type: "plotly-trace-summary",
			description: `${traces.length} traces: ${traces.map((t) => t.name ?? "<unnamed>").join(" | ")}`,
		});

		// 1. There must be at least one trace whose name contains "forecast".
		const forecastTraces = traces.filter((t) => t.name?.includes("forecast"));
		expect(
			forecastTraces.length,
			`expected ≥1 forecast trace, got ${forecastTraces.length} (all traces: ${traces.map((t) => t.name ?? "?").join(", ")})`,
		).toBeGreaterThan(0);

		// 2. The point-forecast trace (the named line one, not the band fills)
		//    must have dashed line styling.
		const dashedForecast = forecastTraces.find(
			(t) => t.line?.dash === "longdash" && !t.fill,
		);
		expect(
			dashedForecast,
			"expected a forecast trace with line.dash='longdash' (imputed-data visual)",
		).toBeDefined();

		// 3. At least one interval-band trace (fill style) should exist for
		//    the dwelling/bedroom combos where AutoARIMA produced ordered
		//    bounds. With North Melbourne having multiple rental series, the
		//    bake almost always produces ≥1 band.
		const bandTraces = forecastTraces.filter((t) => t.fill === "tonexty");
		expect(
			bandTraces.length,
			"expected ≥1 interval-band trace (fill='tonexty')",
		).toBeGreaterThan(0);
	});
});
