// "What's under the hood" panel — renders one row per fitted forecast
// model for the region currently in view. Pulls from the `forecast_models`
// sidecar table (built alongside `forecasts` in the bake) and shows the
// SARIMAX orders, σ²/AICc/N, exog, and lineage (observed vs which
// imputation class fed the input). Wrapped in a <details> so it
// doesn't dominate the page; the analyst opens it when they want the
// "why is this trace shaped this way" detail.
//
// Lineage column ("Source") collapses two facts into one cell:
//   - was the input data observed (vendor) or imputed (Class A/B/C/D)?
//   - what model produced the forecast (`model` column elsewhere)?
// The user can read the chain bottom-to-top: source → model → coefficients.

import { useEffect, useState } from "react";

import type { RegionSelection } from "@/lib/region";
import {
	type ForecastModel,
	queryRegionForecastModels,
} from "@/lib/rental-sales-query";

// AutoARIMA `arma` order is conventionally written as (p,d,q)(P,D,Q)[s].
// `bedroom_borrowed` rows have NULL fields and render as "—".
const formatOrder = (m: ForecastModel): string => {
	if (
		m.arP === null ||
		m.arD === null ||
		m.arQ === null ||
		m.seasonalP === null ||
		m.seasonalD === null ||
		m.seasonalQ === null ||
		m.seasonalPeriod === null
	) {
		return "—";
	}
	return `(${m.arP},${m.arD},${m.arQ})(${m.seasonalP},${m.seasonalD},${m.seasonalQ})[${m.seasonalPeriod}]`;
};

const formatSigma2 = (s: number | null): string => {
	if (s === null || !Number.isFinite(s)) return "—";
	// Sales medians are large (~$1M), so sigma² lands in the 1e8–1e10 range
	// — scientific notation keeps the column narrow without losing the
	// magnitude difference between rental (1e3) and sales (1e9).
	return Math.abs(s) >= 1000 ? s.toExponential(2) : s.toFixed(3);
};

const formatCoefficients = (coef: Record<string, number>): string => {
	const entries = Object.entries(coef);
	if (entries.length === 0) return "—";
	return entries.map(([k, v]) => `${k}=${v.toFixed(3)}`).join(", ");
};

const seriesLabel = (m: ForecastModel): string => {
	const dw = m.dwellingType === "all" ? "All dwellings" : m.dwellingType;
	const br =
		m.bedrooms === "all"
			? "all br"
			: m.bedrooms === "0"
				? "—"
				: `${m.bedrooms} br`;
	return `${m.dataType} · ${dw} · ${br}`;
};

const sourceLabel = (sourceClass: string): string => {
	if (sourceClass === "observed") return "Observed";
	if (sourceClass.startsWith("imputed:")) {
		// "imputed:rollup_rental_dwelling_all" → "Imputed: rollup rental dwelling all"
		const tail = sourceClass.slice("imputed:".length).replaceAll("_", " ");
		return `Imputed · ${tail}`;
	}
	return sourceClass;
};

export const ModelDetailsPanel = ({ region }: { region: RegionSelection }) => {
	const [models, setModels] = useState<ForecastModel[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		setModels(null);
		setError(null);
		queryRegionForecastModels(region.kind, region.code)
			.then(setModels)
			.catch((err: unknown) => {
				setError(err instanceof Error ? err.message : String(err));
				setModels([]);
			});
	}, [region.kind, region.code]);

	if (models === null && error === null) {
		return (
			<div
				className="mt-4 p-2 text-neutral-500 text-xs"
				data-testid="model-details-loading"
			>
				Loading model details…
			</div>
		);
	}
	if (error !== null) {
		return (
			<div
				className="mt-4 p-2 text-red-600 text-xs dark:text-red-300"
				data-testid="model-details-error"
			>
				Failed to load model details: {error}
			</div>
		);
	}
	if (!models || models.length === 0) {
		return (
			<div
				className="mt-4 p-2 text-neutral-500 text-xs"
				data-testid="model-details-empty"
			>
				No fitted models for this region.
			</div>
		);
	}

	return (
		<details
			className="mt-4 rounded-md border border-neutral-200 bg-white p-2 dark:border-neutral-800 dark:bg-neutral-900"
			data-testid="model-details-panel"
		>
			<summary className="cursor-pointer font-medium text-neutral-700 text-sm dark:text-neutral-200">
				Model details
				<span className="ml-2 font-normal text-neutral-500 text-xs dark:text-neutral-400">
					{models.length} fitted series
				</span>
			</summary>
			<div className="mt-2 overflow-x-auto">
				<table className="w-full text-xs">
					<thead className="text-neutral-600 dark:text-neutral-400">
						<tr className="text-left">
							<th className="py-1 pr-3 font-medium">Series</th>
							<th className="py-1 pr-3 font-medium">Method</th>
							<th className="py-1 pr-3 font-medium">Order</th>
							<th className="py-1 pr-3 font-medium">σ²</th>
							<th className="py-1 pr-3 font-medium">AICc</th>
							<th className="py-1 pr-3 font-medium">N</th>
							<th className="py-1 pr-3 font-medium">Exog</th>
							<th className="py-1 pr-3 font-medium">Coefficients</th>
							<th className="py-1 pr-3 font-medium">Source</th>
						</tr>
					</thead>
					<tbody className="font-mono text-neutral-800 dark:text-neutral-200">
						{models.map((m) => (
							<tr
								key={m.seriesId}
								className="border-neutral-100 border-t dark:border-neutral-800"
								data-testid="model-details-row"
							>
								<td className="py-1 pr-3 whitespace-nowrap">
									{seriesLabel(m)}
								</td>
								<td className="py-1 pr-3 whitespace-nowrap">{m.model}</td>
								<td className="py-1 pr-3 whitespace-nowrap">
									{formatOrder(m)}
								</td>
								<td className="py-1 pr-3 whitespace-nowrap text-right">
									{formatSigma2(m.sigma2)}
								</td>
								<td className="py-1 pr-3 whitespace-nowrap text-right">
									{m.aicc === null ? "—" : m.aicc.toFixed(1)}
								</td>
								<td className="py-1 pr-3 whitespace-nowrap text-right">
									{m.nObs ?? "—"}
								</td>
								<td className="py-1 pr-3 whitespace-nowrap">{m.exog}</td>
								<td className="py-1 pr-3 whitespace-nowrap">
									{formatCoefficients(m.coefficients)}
								</td>
								<td className="py-1 pr-3 whitespace-nowrap">
									{sourceLabel(m.sourceClass)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</details>
	);
};
