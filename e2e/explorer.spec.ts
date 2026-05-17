// Explorer SPA e2e — only runs when VITE_ENABLE_EXPLORE=true is set on
// the dev server (see Makefile target `test-e2e-explore`). The default
// `make test-e2e` excludes this spec; production deploys never serve
// the `/explore/*` routes.
//
// Shape: a sanity describe (default redirect + kind toggle + combobox
// navigation) and a full-region-matrix describe — one test per SAL that
// has rental OR sales data + one per LGA. Each matrix test asserts the
// dual plot mounts, both rental and sales panels reach a terminal
// render state (chart OR documented "no data" placeholder), the page
// emits no errors, and per-test network timings get written to
// e2e-screenshots/ for later Gantt visualisation.
//
// Why every SAL + every LGA: per the spec, "All permutations are now
// part of the slug test matrix" — no per-region regression should sneak
// past CI because we only exercised a representative sample.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { env } from "node:process";
import type { Request as PlaywrightRequest } from "@playwright/test";
import { expect, type Page, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// Region catalogue (read at test-collection time so the matrix sizes itself
// from the same source the app does).
// ---------------------------------------------------------------------------

type SuburbMappingEntry = { salName: string };
type SuburbMappings = { salCodes: Record<string, SuburbMappingEntry> };
type LgaNames = Record<string, string>;
type ObservedRegions = { sal: string[]; lga: string[] };

const suburb: SuburbMappings = JSON.parse(
	readFileSync("public/data/suburb_mappings.json", "utf-8"),
);
const lgaNames: LgaNames = JSON.parse(
	readFileSync("public/data/lga_names.json", "utf-8"),
);
// Authoritative observed-data filter — produced by the ETL alongside the
// suburb mapping. Pre-fix the LGA matrix included Unincorporated Vic
// (29399), which has zero rental_sales rows of any kind and rendered the
// not-found placeholder; this filter drops it.
const observed: ObservedRegions = JSON.parse(
	readFileSync("public/data/observed_regions.json", "utf-8"),
);
const observedSal = new Set(observed.sal);
const observedLga = new Set(observed.lga);

type RegionKind = "sal" | "lga";
type Entry = {
	kind: RegionKind;
	code: string;
	name: string;
};

const SAL_ENTRIES: Entry[] = Object.entries(suburb.salCodes)
	.filter(([code]) => observedSal.has(code))
	.map(([code, v]): Entry => ({ kind: "sal", code, name: v.salName }))
	.sort((a, b) => a.code.localeCompare(b.code));

const LGA_ENTRIES: Entry[] = Object.entries(lgaNames)
	.filter(([code]) => observedLga.has(code))
	.map(([code, name]): Entry => ({ kind: "lga", code, name }))
	.sort((a, b) => a.code.localeCompare(b.code));

const ALL_ENTRIES: Entry[] = [...SAL_ENTRIES, ...LGA_ENTRIES];

// Stable artifact slug. ID-based so artifacts sort the way the matrix
// iterates rather than by region name (which would scramble per-kind
// blocks together).
const pad = (n: number, width: number): string =>
	String(n).padStart(width, "0");

const safeName = (name: string): string =>
	name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 40);

const entrySlug = (idx: number, entry: Entry): string =>
	`S${pad(idx, 4)}_${entry.kind.toUpperCase()}_${entry.code}_${safeName(entry.name)}`;

// ---------------------------------------------------------------------------
// Per-test IO collector: console + page errors → log file, request timing →
// network.json. Reused across the matrix so every region produces a uniform
// triplet of (screenshot? log + network.json) for analysis after a CI run.
// ---------------------------------------------------------------------------

interface NetworkTiming {
	url: string;
	method: string;
	status: number | null;
	start_offset_ms: number;
	duration_ms: number;
	resource_type: string;
}

interface TestCollector {
	pageErrors: string[];
	consoleErrors: string[];
	writeLog: (slug: string) => void;
}

const collectTestIO = (page: Page): TestCollector => {
	const testStart = Date.now();
	const lines: string[] = [];
	const pageErrors: string[] = [];
	const consoleErrors: string[] = [];
	page.on("pageerror", (err) => {
		pageErrors.push(err.message);
		lines.push(`[PAGE_ERROR] ${err.message}`);
	});
	page.on("console", (msg) => {
		const type = msg.type();
		const text = msg.text();
		lines.push(`[${type.toUpperCase().padEnd(7)}] ${text}`);
		if (type === "error") consoleErrors.push(text);
	});

	const network: NetworkTiming[] = [];
	const pending = new Map<PlaywrightRequest, number>();
	page.on("request", (req) => {
		pending.set(req, Date.now());
	});
	page.on("requestfinished", async (req) => {
		const start = pending.get(req);
		if (start === undefined) return;
		pending.delete(req);
		const res = await req.response();
		network.push({
			url: req.url(),
			method: req.method(),
			status: res ? res.status() : null,
			start_offset_ms: start - testStart,
			duration_ms: Date.now() - start,
			resource_type: req.resourceType(),
		});
	});
	page.on("requestfailed", (req) => {
		const start = pending.get(req);
		if (start === undefined) return;
		pending.delete(req);
		network.push({
			url: req.url(),
			method: req.method(),
			status: null,
			start_offset_ms: start - testStart,
			duration_ms: Date.now() - start,
			resource_type: req.resourceType(),
		});
	});

	return {
		pageErrors,
		consoleErrors,
		writeLog(slug: string): void {
			const dir = "e2e-screenshots";
			mkdirSync(dir, { recursive: true });
			writeFileSync(`${dir}/${slug}.log`, `${lines.join("\n")}\n`, "utf-8");
			const wallClockEnd = network.reduce(
				(max, n) => Math.max(max, n.start_offset_ms + n.duration_ms),
				0,
			);
			const summary = {
				test_start_ms: testStart,
				wall_clock_duration_ms: wallClockEnd,
				total_requests: network.length,
				total_duration_ms: network.reduce((s, n) => s + n.duration_ms, 0),
				all_requests: [...network].sort(
					(a, b) => a.start_offset_ms - b.start_offset_ms,
				),
			};
			writeFileSync(
				`${dir}/${slug}.network.json`,
				`${JSON.stringify(summary, null, 2)}\n`,
				"utf-8",
			);
		},
	};
};

// ---------------------------------------------------------------------------
// Sanity: redirect, kind toggle, combobox navigation. Five quick tests that
// guard the page chrome; the matrix below assumes these stay green.
// ---------------------------------------------------------------------------

const DEFAULT_LGA_ID = "24600"; // Melbourne — matches the app's redirect target.
const DEFAULT_SAL_ID = "20002"; // Abbotsford (Vic.)

test.describe("Explorer · /explore · sanity", () => {
	test.skip(
		env.VITE_ENABLE_EXPLORE !== "true",
		"VITE_ENABLE_EXPLORE not set — Explorer not built into the bundle",
	);

	test("/explore (no id) redirects to the default LGA", async ({ page }) => {
		await page.goto("/explore");
		await expect(page).toHaveURL(
			new RegExp(`/explore/lga/${DEFAULT_LGA_ID}$`),
			{ timeout: 30_000 },
		);
		await expect(page.locator('[data-testid="region-explorer"]')).toBeVisible({
			timeout: 30_000,
		});
	});

	test("/explore/lga/:id renders the dual plot for Melbourne", async ({
		page,
	}) => {
		await page.goto(`/explore/lga/${DEFAULT_LGA_ID}`);
		await expect(page.locator('[data-testid="region-dual-plot"]')).toBeVisible({
			timeout: 30_000,
		});
		await expect(
			page.locator('[data-testid="suburb-plot-rental-ready"]'),
		).toBeVisible({ timeout: 30_000 });
		await expect(
			page.locator('[data-testid="suburb-plot-sales-ready"]'),
		).toBeVisible({ timeout: 30_000 });
	});

	test("kind toggle navigates from LGA to default SAL", async ({ page }) => {
		await page.goto(`/explore/lga/${DEFAULT_LGA_ID}`);
		await expect(page.locator('[data-testid="region-explorer"]')).toBeVisible({
			timeout: 30_000,
		});
		await page.locator('[data-testid="region-kind-sal"]').click();
		await expect(page).toHaveURL(
			new RegExp(`/explore/sal/${DEFAULT_SAL_ID}$`),
			{ timeout: 30_000 },
		);
	});

	test("region picker: search narrows list and clicking an item navigates", async ({
		page,
	}) => {
		await page.goto(`/explore/lga/${DEFAULT_LGA_ID}`);
		const search = page.locator('[data-testid="region-picker-search"]');
		await expect(search).toBeVisible({ timeout: 30_000 });
		// Pre-search: the list shows every observed LGA (79).
		const allItems = page.locator('[data-testid="region-picker-item"]');
		await expect(allItems).toHaveCount(observedLga.size);
		// Search by substring — only Boroondara remains.
		await search.fill("Boroondara");
		await expect(allItems).toHaveCount(1);
		await allItems.first().click();
		await expect(page).toHaveURL(/\/explore\/lga\/21110$/, { timeout: 10_000 });
	});

	test("region picker list scrolls within a bounded container", async ({
		page,
	}) => {
		// 760 SAL entries × ~28px each ≈ 21k px — far taller than any
		// viewport. If the picker isn't bounded by its parent height, the
		// page (not the list) would scroll. Assert scrollHeight > clientHeight
		// so this regression can't slip past.
		await page.goto(`/explore/sal/${DEFAULT_SAL_ID}`);
		const list = page.locator('[data-testid="region-picker-list"]');
		await expect(list).toBeVisible({ timeout: 30_000 });
		const { scrollH, clientH } = await list.evaluate((el) => ({
			scrollH: el.scrollHeight,
			clientH: el.clientHeight,
		}));
		expect(scrollH).toBeGreaterThan(clientH);
	});

	test("model details panel renders fitted SARIMAX rows for Melbourne", async ({
		page,
	}) => {
		await page.goto(`/explore/lga/${DEFAULT_LGA_ID}`);
		const panel = page.locator('[data-testid="model-details-panel"]');
		await expect(panel).toBeVisible({ timeout: 30_000 });
		// <details> is collapsed by default — expand it before asserting rows.
		await panel.locator("summary").click();
		await expect(
			page.locator('[data-testid="model-details-row"]').first(),
		).toBeVisible({ timeout: 10_000 });
	});

	test("/explore/dendrogram redirects to the SAL dendrogram", async ({
		page,
	}) => {
		await page.goto("/explore/dendrogram");
		await expect(page).toHaveURL(/\/explore\/dendrogram\/sal$/, {
			timeout: 30_000,
		});
		await expect(
			page.locator('[data-testid="dendrogram-explorer"]'),
		).toBeVisible({ timeout: 30_000 });
	});

	test("dendrogram (SAL) renders the Cytoscape canvas — sankey + K-cut inspector removed", async ({
		page,
	}) => {
		await page.goto("/explore/dendrogram/sal");
		await expect(
			page.locator('[data-testid="dendrogram-explorer"]'),
		).toBeVisible({ timeout: 30_000 });
		// The Cytoscape dendrogram is now the only view on the page.
		await expect(
			page.locator('[data-testid="cluster-dendrogram"]'),
		).toBeVisible({ timeout: 30_000 });
		await expect(
			page.locator('[data-testid="cluster-dendrogram-canvas"]'),
		).toBeVisible({ timeout: 30_000 });
		// Removed legacy widgets must not reappear.
		await expect(page.locator('[data-testid="cluster-sankey"]')).toHaveCount(0);
		await expect(
			page.locator('[data-testid="dendrogram-size-chart"]'),
		).toHaveCount(0);
		await expect(
			page.locator('[data-testid="dendrogram-cluster"]'),
		).toHaveCount(0);
		await expect(
			page.locator('[data-testid^="dendrogram-level-"]'),
		).toHaveCount(0);
	});

	test("dendrogram (LGA) renders the Cytoscape canvas with the EVoC method switch", async ({
		page,
	}) => {
		await page.goto("/explore/dendrogram/lga");
		await expect(
			page.locator('[data-testid="dendrogram-explorer"]'),
		).toBeVisible({ timeout: 30_000 });
		await expect(
			page.locator('[data-testid="cluster-dendrogram-canvas"]'),
		).toBeVisible({ timeout: 30_000 });
		await page
			.locator('[data-testid="cluster-dendrogram-method-evoc"]')
			.click();
		await expect(page).toHaveURL(/method=evoc/, { timeout: 5_000 });
	});

	test("/explore/overview renders SAL + LGA totals and per-slice coverage", async ({
		page,
	}) => {
		await page.goto("/explore/overview");
		// Container mounts once the duckdb-backed query resolves.
		await expect(page.locator('[data-testid="overview-root"]')).toBeVisible({
			timeout: 30_000,
		});
		// Two tier blocks present.
		await expect(
			page.locator('[data-testid="overview-tier-sal"]'),
		).toBeVisible();
		await expect(
			page.locator('[data-testid="overview-tier-lga"]'),
		).toBeVisible();
		// Totals are populated from region_totals.json — assert the
		// production-known counts so a future regression that wipes the
		// file or the publish step is caught.
		await expect(page.locator('[data-testid="overview-sal-total"]')).toHaveText(
			/2,?946/,
		);
		await expect(page.locator('[data-testid="overview-lga-total"]')).toHaveText(
			/^80$/,
		);
		// At least one per-slice row was emitted per tier (the SQL produced
		// a non-empty pivot, not just an empty header).
		expect(
			await page.locator('[data-testid="overview-sal-row"]').count(),
		).toBeGreaterThan(0);
		expect(
			await page.locator('[data-testid="overview-lga-row"]').count(),
		).toBeGreaterThan(0);
	});

	test("/explore/overview cell click reveals a Deck.GL polygon overlay", async ({
		page,
	}) => {
		await page.goto("/explore/overview");
		await expect(page.locator('[data-testid="overview-root"]')).toBeVisible({
			timeout: 30_000,
		});
		// Map should NOT be visible before any cell is clicked.
		await expect(
			page.locator('[data-testid="tier-polygon-map-lga"]'),
		).toHaveCount(0);
		// LGA House 3br has full coverage (79/79) — a known-dense cell
		// guarantees the map gets non-empty data even if cell-level coverage
		// changes for other slices over time.
		await page
			.locator('[data-testid="overview-cell-lga-house-3-observed"]')
			.first()
			.click();
		// Map mounts under the LGA tier table.
		await expect(
			page.locator('[data-testid="tier-polygon-map-lga"]'),
		).toBeVisible({ timeout: 30_000 });
		await expect(
			page.locator('[data-testid="tier-polygon-map-lga-label"]'),
		).toContainText(/house \/ 3br/);
		// Polygon-count label updates with the actual count painted.
		await expect(
			page.locator('[data-testid="tier-polygon-map-lga-count"]'),
		).toContainText(/\d+ polygons painted/, { timeout: 30_000 });
		// SAL map should still be absent — selection is per-tier.
		await expect(
			page.locator('[data-testid="tier-polygon-map-sal"]'),
		).toHaveCount(0);
	});

	test("/explore/overview shows the lineage classification + per-polygon drilldown", async ({
		page,
	}) => {
		await page.goto("/explore/overview");
		await expect(page.locator('[data-testid="overview-root"]')).toBeVisible({
			timeout: 30_000,
		});
		// Lineage panel mounts once the per-tier classification resolves.
		await expect(page.locator('[data-testid="lineage-panel-lga"]')).toBeVisible(
			{ timeout: 30_000 },
		);
		// At least one P-pattern was emitted (LGA has multiple vendor gaps).
		expect(
			await page.locator('[data-testid^="lineage-pattern-lga-P"]').count(),
		).toBeGreaterThan(0);
		// Per-polygon drilldown: type Melbourne LGA (24600) and assert the
		// presence-matrix table renders.
		await page
			.locator('[data-testid="polygon-lineage-input-lga"]')
			.fill("24600");
		await expect(
			page.locator('[data-testid="polygon-lineage-table-lga"]'),
		).toBeVisible({ timeout: 30_000 });
	});

	test("side-nav Summary link points to /explore/overview", async ({
		page,
	}) => {
		await page.goto(`/explore/lga/${DEFAULT_LGA_ID}`);
		await page.locator('[data-testid="nav-summary-overview"]').click();
		await expect(page).toHaveURL(/\/explore\/overview$/, { timeout: 10_000 });
		await expect(page.locator('[data-testid="overview-root"]')).toBeVisible({
			timeout: 30_000,
		});
	});

	test("dendrogram renders the Cytoscape canvas with method selector", async ({
		page,
	}) => {
		await page.goto("/explore/dendrogram/sal");
		await expect(
			page.locator('[data-testid="cluster-dendrogram"]'),
		).toBeVisible({ timeout: 30_000 });
		await expect(
			page.locator('[data-testid="cluster-dendrogram-canvas"]'),
		).toBeVisible({ timeout: 30_000 });
		await expect(
			page.locator('[data-testid="cluster-dendrogram-method-hdbscan"]'),
		).toBeVisible();
		await expect(
			page.locator('[data-testid="cluster-dendrogram-method-evoc"]'),
		).toBeVisible();
		// Method switch updates the URL (the dendrogram explorer mirrors
		// method into ?method= so the view is deep-linkable).
		await page
			.locator('[data-testid="cluster-dendrogram-method-evoc"]')
			.click();
		await expect(page).toHaveURL(/method=evoc/, { timeout: 5_000 });
	});

	test("side-nav cluster link navigates to the SAL dendrogram", async ({
		page,
	}) => {
		await page.goto(`/explore/lga/${DEFAULT_LGA_ID}`);
		await page.locator('[data-testid="nav-cluster-sal"]').click();
		await expect(page).toHaveURL(/\/explore\/dendrogram\/sal$/, {
			timeout: 10_000,
		});
		await expect(
			page.locator('[data-testid="dendrogram-explorer"]'),
		).toBeVisible({ timeout: 30_000 });
	});

	test("region picker collapse persists across reload", async ({ page }) => {
		await page.goto(`/explore/lga/${DEFAULT_LGA_ID}`);
		const picker = page.locator('[data-testid="region-picker"]');
		await expect(picker).toBeVisible({ timeout: 30_000 });
		await expect(picker).toHaveAttribute("data-collapsed", "false");
		await page.locator('[data-testid="region-picker-toggle"]').click();
		await expect(picker).toHaveAttribute("data-collapsed", "true");
		await page.reload();
		await expect(page.locator('[data-testid="region-picker"]')).toHaveAttribute(
			"data-collapsed",
			"true",
		);
	});

	test("unknown id renders the not-found placeholder", async ({ page }) => {
		await page.goto("/explore/sal/99999999");
		await expect(page.locator('[data-testid="region-not-found"]')).toBeVisible({
			timeout: 30_000,
		});
	});

	test("side panel collapse toggles width and persists across reload", async ({
		page,
	}) => {
		await page.goto(`/explore/lga/${DEFAULT_LGA_ID}`);
		const nav = page.locator('[data-testid="explorer-sidenav"]');
		await expect(nav).toBeVisible({ timeout: 30_000 });
		// Starts expanded (data-collapsed="false") on a fresh localStorage.
		await expect(nav).toHaveAttribute("data-collapsed", "false");

		await page.locator('[data-testid="explorer-sidenav-toggle"]').click();
		await expect(nav).toHaveAttribute("data-collapsed", "true");

		// Persists across reload via localStorage.
		await page.reload();
		await expect(
			page.locator('[data-testid="explorer-sidenav"]'),
		).toHaveAttribute("data-collapsed", "true");
	});
});

// ---------------------------------------------------------------------------
// The matrix: one test per SAL with data + one per LGA. Each asserts the
// dual plot mounted, both panels reached a terminal state, and the page
// raised no errors. Per-test artifacts land under e2e-screenshots/ with a
// stable id-padded slug.
// ---------------------------------------------------------------------------

test.describe("Explorer · /explore · region matrix", () => {
	test.skip(
		env.VITE_ENABLE_EXPLORE !== "true",
		"VITE_ENABLE_EXPLORE not set — Explorer not built into the bundle",
	);

	ALL_ENTRIES.forEach((entry, idx) => {
		const slug = entrySlug(idx, entry);
		const label = `${slug} · ${entry.name}`;
		test(label, async ({ page }) => {
			const io = collectTestIO(page);
			await page.goto(`/explore/${entry.kind}/${entry.code}`);

			// Region resolved + dual-plot mounted.
			await expect(page.locator('[data-testid="region-explorer"]')).toBeVisible(
				{ timeout: 30_000 },
			);
			await expect(
				page.locator('[data-testid="region-dual-plot"]'),
			).toBeVisible({ timeout: 30_000 });

			// Both panels reach a terminal state. `suburb-plot-${view}-ready`
			// fires for chart / empty-view / empty-region / error — i.e.
			// anything but loading. Stuck-loading is what we want to catch.
			await expect(
				page.locator('[data-testid="suburb-plot-rental-ready"]'),
			).toBeVisible({ timeout: 30_000 });
			await expect(
				page.locator('[data-testid="suburb-plot-sales-ready"]'),
			).toBeVisible({ timeout: 30_000 });

			io.writeLog(slug);
			expect(io.pageErrors, `${slug}: page errors`).toEqual([]);
		});
	});
});
