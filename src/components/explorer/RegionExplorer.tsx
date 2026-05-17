// The /explore page. One component backs both /explore/sal/:salId and
// /explore/lga/:lgaId — `kind` is the only difference. Layout is:
//
//   [ExplorerSideNav]  [RegionPicker]  [dual-plot content]
//
// The side-nav (owned by Explorer.tsx) switches kinds; the picker shows
// every observed-data region within the active kind; the content shows
// the rental + sales charts for whichever region the URL selects.
//
// URL is the source of truth — clicking a picker entry navigates, a
// pasted link reproduces the exact view, the kind-toggle preserves
// neither (each kind has its own default landing). The region list is
// filtered against `observed_regions.json` so only regions with at
// least one OBSERVED (non-imputed) row in rental_sales appear; the
// route itself is unrestricted so a typed-in URL to a dataless region
// still renders the not-found placeholder.

import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";

import { ModelDetailsPanel } from "@/components/explorer/ModelDetailsPanel";
import { RegionDualPlot } from "@/components/explorer/RegionDualPlot";
import {
	RegionPicker,
	type RegionPickerOption,
} from "@/components/explorer/RegionPicker";
import { versionedUrl } from "@/lib/data-version";
import type { RegionSelection } from "@/lib/region";
import type { RegionKind } from "@/lib/rental-sales-query";
import {
	getSuburbMappings,
	loadSuburbMappings,
	type SuburbMappings,
} from "@/lib/suburb-mappings";

// Known-good defaults — used by /explore redirect and by ExplorerSideNav's
// kind-toggle (we don't know the spatial parent/child of the current
// region, so the toggle goes to the *kind's* default landing).
export const DEFAULT_SAL_ID = "20002"; // Abbotsford (Vic.)
export const DEFAULT_LGA_ID = "24600"; // Melbourne

// ---------------------------------------------------------------------------
// Async JSON catalogues — fetched once and cached at module scope so the
// data follows the user across kind toggles without a re-fetch each visit.
// ---------------------------------------------------------------------------

type LgaNames = Record<string, string>;
type ObservedRegions = { sal: Set<string>; lga: Set<string> };

let _lgaCache: LgaNames | null = null;
let _lgaPromise: Promise<LgaNames> | null = null;

const loadLgaNames = (): Promise<LgaNames> => {
	if (_lgaCache) return Promise.resolve(_lgaCache);
	if (!_lgaPromise) {
		_lgaPromise = fetch(versionedUrl("data/lga_names.json"))
			.then((r) => {
				if (!r.ok) throw new Error(`lga_names.json ${r.status}`);
				return r.json() as Promise<LgaNames>;
			})
			.then((d) => {
				_lgaCache = d;
				return d;
			});
	}
	return _lgaPromise;
};

let _observedCache: ObservedRegions | null = null;
let _observedPromise: Promise<ObservedRegions> | null = null;

const loadObservedRegions = (): Promise<ObservedRegions> => {
	if (_observedCache) return Promise.resolve(_observedCache);
	if (!_observedPromise) {
		_observedPromise = fetch(versionedUrl("data/observed_regions.json"))
			.then((r) => {
				if (!r.ok) throw new Error(`observed_regions.json ${r.status}`);
				return r.json() as Promise<{ sal: string[]; lga: string[] }>;
			})
			.then((d) => {
				const v: ObservedRegions = {
					sal: new Set(d.sal),
					lga: new Set(d.lga),
				};
				_observedCache = v;
				return v;
			});
	}
	return _observedPromise;
};

const useSuburbMappingsState = (): SuburbMappings | null => {
	const [state, setState] = useState<SuburbMappings | null>(() =>
		getSuburbMappings(),
	);
	useEffect(() => {
		if (state) return;
		loadSuburbMappings(versionedUrl("data/suburb_mappings.json"))
			.then(setState)
			.catch(() => {
				/* surfaced via empty options list */
			});
	}, [state]);
	return state;
};

const useLgaNames = (): LgaNames | null => {
	const [names, setNames] = useState<LgaNames | null>(() => _lgaCache);
	useEffect(() => {
		if (names) return;
		loadLgaNames()
			.then(setNames)
			.catch(() => {
				/* surfaced via empty options list */
			});
	}, [names]);
	return names;
};

const useObservedRegions = (): ObservedRegions | null => {
	const [state, setState] = useState<ObservedRegions | null>(
		() => _observedCache,
	);
	useEffect(() => {
		if (state) return;
		loadObservedRegions()
			.then(setState)
			.catch(() => {
				/* surfaced via empty options list */
			});
	}, [state]);
	return state;
};

// ---------------------------------------------------------------------------

export const RegionExplorer = ({ kind }: { kind: RegionKind }) => {
	const { id = "" } = useParams<{ id: string }>();

	const mappings = useSuburbMappingsState();
	const lgaNames = useLgaNames();
	const observed = useObservedRegions();

	const options = useMemo<RegionPickerOption[]>(() => {
		if (!observed) return [];
		if (kind === "suburb" && mappings) {
			return Object.entries(mappings.salCodes)
				.filter(([code]) => observed.sal.has(code))
				.map(([code, v]) => ({ code, name: v.salName }))
				.sort((a, b) => a.name.localeCompare(b.name));
		}
		if (kind === "lga" && lgaNames) {
			return Object.entries(lgaNames)
				.filter(([code]) => observed.lga.has(code))
				.map(([code, name]) => ({ code, name }))
				.sort((a, b) => a.name.localeCompare(b.name));
		}
		return [];
	}, [kind, mappings, lgaNames, observed]);

	const selection = useMemo<RegionSelection | null>(() => {
		const opt = options.find((o) => o.code === id);
		return opt ? { kind, code: opt.code, name: opt.name } : null;
	}, [kind, id, options]);

	const kindLabel = kind === "suburb" ? "SAL" : "LGA";

	return (
		<div className="flex h-full">
			<RegionPicker kind={kind} options={options} selectedCode={id} />
			<div
				className="min-w-0 flex-1 overflow-y-auto p-3"
				data-testid="region-explorer"
			>
				<header className="mb-3 flex flex-wrap items-baseline gap-3 border-neutral-200 border-b pb-3 dark:border-neutral-800">
					<h1 className="font-medium text-base text-neutral-900 dark:text-neutral-100">
						{selection ? (
							<>
								{selection.name}{" "}
								<span className="ml-1 font-normal text-neutral-500 text-sm dark:text-neutral-400">
									{kindLabel} {selection.code}
								</span>
							</>
						) : (
							<span className="text-neutral-500 dark:text-neutral-400">
								Select a {kindLabel} from the panel on the left.
							</span>
						)}
					</h1>
				</header>

				{options.length === 0 ? (
					<div
						className="p-4 text-neutral-500 text-sm"
						data-testid="region-loading"
					>
						Loading {kindLabel}s…
					</div>
				) : !selection ? (
					<div
						className="p-4 text-amber-700 text-sm dark:text-amber-300"
						data-testid="region-not-found"
					>
						No {kindLabel} found for id <code>{id}</code>. Pick one from the
						panel on the left.
					</div>
				) : (
					<>
						<RegionDualPlot region={selection} />
						<ModelDetailsPanel region={selection} />
					</>
				)}
			</div>
		</div>
	);
};
