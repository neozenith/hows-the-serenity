// Side panel on /explore/* — kind navigation + theme toggle. Two sections:
//
//   Regions   — per-area dual-plot pages (SAL, LGA region explorers).
//   Clusters  — agglomerative-hierarchy inspector (SAL, LGA dendrograms).
//
// Collapsible; collapse state persists to localStorage so a dense analyst
// layout survives reloads. Active state is URL-prefix based so any sub-route
// under e.g. /explore/dendrogram/* highlights the matching link.

import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";

import {
	DEFAULT_LGA_ID,
	DEFAULT_SAL_ID,
} from "@/components/explorer/RegionExplorer";
import { ThemeToggle } from "@/components/ThemeToggle";

type LinkSpec = {
	key: string;
	label: string;
	abbrev: string;
	to: string;
	prefix: string;
};

type Section = {
	heading: string;
	links: LinkSpec[];
};

const SECTIONS: Section[] = [
	{
		heading: "Summary",
		links: [
			{
				key: "summary-overview",
				label: "Overview",
				abbrev: "Σ",
				to: "/explore/overview",
				prefix: "/explore/overview",
			},
		],
	},
	{
		heading: "Regions",
		links: [
			{
				key: "region-sal",
				label: "SALs",
				abbrev: "S",
				to: `/explore/sal/${DEFAULT_SAL_ID}`,
				prefix: "/explore/sal/",
			},
			{
				key: "region-lga",
				label: "LGAs",
				abbrev: "L",
				to: `/explore/lga/${DEFAULT_LGA_ID}`,
				prefix: "/explore/lga/",
			},
		],
	},
	{
		heading: "Clusters",
		links: [
			{
				key: "cluster-sal",
				label: "SAL clusters",
				abbrev: "S·c",
				to: "/explore/dendrogram/sal",
				prefix: "/explore/dendrogram/sal",
			},
			{
				key: "cluster-lga",
				label: "LGA clusters",
				abbrev: "L·c",
				to: "/explore/dendrogram/lga",
				prefix: "/explore/dendrogram/lga",
			},
		],
	},
];

const STORAGE_KEY = "hts:explorer-sidenav-collapsed";

const readCollapsed = (): boolean => {
	if (typeof window === "undefined") return false;
	try {
		return window.localStorage.getItem(STORAGE_KEY) === "1";
	} catch {
		return false;
	}
};

export const ExplorerSideNav = () => {
	const { pathname } = useLocation();
	const [collapsed, setCollapsed] = useState<boolean>(readCollapsed);

	useEffect(() => {
		try {
			window.localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
		} catch {
			/* best-effort persistence; not having it is non-fatal */
		}
	}, [collapsed]);

	const renderLink = (l: LinkSpec) => {
		const active = pathname.startsWith(l.prefix);
		// region-kind-{sal|lga} testid is still honoured for the SAL/LGA region
		// links so the existing sanity tests don't churn. Cluster links get a
		// distinct testid family.
		const testid = l.key.startsWith("region-")
			? `region-kind-${l.key.slice("region-".length)}`
			: `nav-${l.key}`;
		return (
			<Link
				to={l.to}
				data-testid={testid}
				aria-current={active ? "page" : undefined}
				title={l.label}
				className={[
					"block rounded-md px-3 py-1.5 text-sm transition-colors",
					collapsed ? "px-0 text-center" : "text-left",
					active
						? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
						: "text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800",
				].join(" ")}
			>
				{collapsed ? l.abbrev : l.label}
			</Link>
		);
	};

	return (
		<nav
			data-testid="explorer-sidenav"
			data-collapsed={collapsed ? "true" : "false"}
			className={[
				"flex shrink-0 flex-col gap-2 border-neutral-200 border-r bg-white p-2 transition-[width] duration-150",
				"dark:border-neutral-800 dark:bg-neutral-950",
				collapsed ? "w-12" : "w-44",
			].join(" ")}
		>
			<div className="flex items-center justify-between">
				{!collapsed && (
					<h2 className="px-1 font-medium text-neutral-500 text-xs uppercase tracking-wide dark:text-neutral-400">
						Explore
					</h2>
				)}
				<button
					type="button"
					onClick={() => setCollapsed((c) => !c)}
					aria-label={collapsed ? "Expand side panel" : "Collapse side panel"}
					aria-expanded={!collapsed}
					title={collapsed ? "Expand" : "Collapse"}
					data-testid="explorer-sidenav-toggle"
					className="ml-auto rounded px-1.5 py-0.5 text-neutral-500 text-sm hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
				>
					{collapsed ? "›" : "‹"}
				</button>
			</div>

			<div className="flex flex-col gap-3">
				{SECTIONS.map((section) => (
					<section key={section.heading}>
						{!collapsed && (
							<h3 className="mb-1 px-1 font-medium text-[10px] text-neutral-500 uppercase tracking-wide dark:text-neutral-500">
								{section.heading}
							</h3>
						)}
						<ul className="flex flex-col gap-1">
							{section.links.map((l) => (
								<li key={l.key}>{renderLink(l)}</li>
							))}
						</ul>
					</section>
				))}
			</div>

			<div
				className={[
					"mt-auto flex border-neutral-200 border-t pt-2 dark:border-neutral-800",
					collapsed ? "justify-center" : "justify-end",
				].join(" ")}
			>
				<ThemeToggle />
			</div>
		</nav>
	);
};
