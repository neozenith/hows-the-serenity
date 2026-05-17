// Secondary side panel on each /explore page — the in-kind region picker.
// Renders one row per (code, name) entry as a router <Link>, with a search
// input filtering by name or code substring. Collapsible; collapse state
// persists to localStorage so the analyst's workspace shape survives
// across reloads.
//
// Replaces the previous header `<input list>` + `<datalist>` combobox.
// That widget was native HTML autocomplete but offered no overview — you
// had to KNOW what to type. This one shows every available region in a
// vertical scrollable list, with the current selection highlighted, so
// browsing siblings is one glance away.
//
// The full options array comes from RegionExplorer (already sorted by
// name and pre-filtered to the observed-data set), so this component
// stays pure: search filter, render, click → navigate. No data fetching
// or routing logic here.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import type { RegionKind } from "@/lib/rental-sales-query";

export type RegionPickerOption = { code: string; name: string };

type Props = {
	kind: RegionKind;
	options: ReadonlyArray<RegionPickerOption>;
	selectedCode: string;
};

const STORAGE_KEY = "hts:region-picker-collapsed";

const readCollapsed = (): boolean => {
	if (typeof window === "undefined") return false;
	try {
		return window.localStorage.getItem(STORAGE_KEY) === "1";
	} catch {
		return false;
	}
};

export const RegionPicker = ({ kind, options, selectedCode }: Props) => {
	const [collapsed, setCollapsed] = useState<boolean>(readCollapsed);
	const [search, setSearch] = useState<string>("");

	useEffect(() => {
		try {
			window.localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
		} catch {
			/* best-effort */
		}
	}, [collapsed]);

	const routePrefix = kind === "suburb" ? "/explore/sal/" : "/explore/lga/";
	const label = kind === "suburb" ? "SAL" : "LGA";

	const q = search.trim().toLowerCase();
	const filtered =
		q === ""
			? options
			: options.filter(
					(o) =>
						o.name.toLowerCase().includes(q) ||
						o.code.toLowerCase().includes(q),
				);

	return (
		<aside
			data-testid="region-picker"
			data-collapsed={collapsed ? "true" : "false"}
			className={[
				"flex shrink-0 flex-col gap-2 border-neutral-200 border-r bg-white p-2 transition-[width] duration-150",
				"dark:border-neutral-800 dark:bg-neutral-950",
				collapsed ? "w-12" : "w-72",
			].join(" ")}
		>
			<div className="flex items-center justify-between">
				{!collapsed && (
					<h2 className="px-1 font-medium text-neutral-500 text-xs uppercase tracking-wide dark:text-neutral-400">
						{label}s ({options.length.toLocaleString()})
					</h2>
				)}
				<button
					type="button"
					onClick={() => setCollapsed((c) => !c)}
					aria-label={
						collapsed ? "Expand region picker" : "Collapse region picker"
					}
					aria-expanded={!collapsed}
					title={collapsed ? "Expand" : "Collapse"}
					data-testid="region-picker-toggle"
					className="ml-auto rounded px-1.5 py-0.5 text-neutral-500 text-sm hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
				>
					{collapsed ? "›" : "‹"}
				</button>
			</div>

			{!collapsed && (
				<>
					<input
						type="search"
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder={`Search ${options.length.toLocaleString()} ${label}s…`}
						className="rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
						data-testid="region-picker-search"
					/>
					<ul
						// min-h-0 lets `flex-1` actually shrink the list below its
						// intrinsic content height (760 SAL items would otherwise
						// blow past the viewport because flex children default to
						// min-height: auto). With it, the list takes the remaining
						// aside height and overflow-y-auto kicks in.
						className="min-h-0 flex-1 overflow-y-auto rounded border border-neutral-200 dark:border-neutral-800"
						data-testid="region-picker-list"
					>
						{filtered.length === 0 ? (
							<li
								className="p-2 text-neutral-500 text-xs"
								data-testid="region-picker-empty"
							>
								No matches
							</li>
						) : (
							filtered.map((o) => {
								const active = o.code === selectedCode;
								return (
									<li key={o.code}>
										<Link
											to={`${routePrefix}${o.code}`}
											data-testid="region-picker-item"
											data-code={o.code}
											aria-current={active ? "page" : undefined}
											className={[
												"flex items-center justify-between gap-2 px-2 py-1 text-sm",
												active
													? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
													: "text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800",
											].join(" ")}
										>
											<span className="truncate">{o.name}</span>
											<span
												className={
													active
														? "text-neutral-300 text-xs dark:text-neutral-700"
														: "text-neutral-400 text-xs dark:text-neutral-600"
												}
											>
												{o.code}
											</span>
										</Link>
									</li>
								);
							})
						)}
					</ul>
				</>
			)}
		</aside>
	);
};
