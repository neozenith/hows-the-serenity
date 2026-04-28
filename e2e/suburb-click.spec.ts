import { mkdirSync, writeFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

/**
 * Suburb-selection e2e: drive selection programmatically via the
 * `window.__htsSelectRegion(...)` test hook, assert the plot panel
 * renders, take a full-page screenshot, and verify there are no
 * console errors (especially no "Render error: …" in the
 * ErrorBoundary fallback).
 *
 * Why a programmatic selection rather than a real canvas click: deck.gl's
 * picking framebuffer doesn't reliably resolve synthesized Playwright
 * clicks — the picking pass races the input event loop on a freshly
 * rendered MVTLayer. Manual users hit the full click→pick→onClick path
 * and surface any crash there. The test's job is to exercise the
 * downstream chain: DuckDB query, Plotly lazy load, and chart render.
 */

const ARTIFACT_DIR = "e2e-screenshots";
// Default theme is dark, so the rental/sales captures are inherently
// dark-themed. SLUG_LIGHT is the post-toggle screenshot proving the switch
// to light mode also works.
const SLUG_RENTAL = "S00_home-suburb-click-rental";
const SLUG_SALES = "S00_home-suburb-click-sales";
const SLUG_LIGHT = "S00_home-suburb-click-light";
// Single shared log slug — all view captures write into the same console log.
const SLUG_LOG = "S00_home-suburb-click";

const ensureDir = () => mkdirSync(ARTIFACT_DIR, { recursive: true });

const collectErrors = (page: Page): { errors: string[]; lines: string[] } => {
	const errors: string[] = [];
	const lines: string[] = [];
	page.on("pageerror", (err) => {
		const line = `[PAGE_ERROR] ${err.message}`;
		lines.push(line);
		errors.push(err.message);
	});
	page.on("console", (msg) => {
		const level = msg.type().toUpperCase().padEnd(7);
		lines.push(`[${level}] ${msg.text()}`);
		if (msg.type() === "error") errors.push(msg.text());
	});
	return { errors, lines };
};

const filterRealErrors = (errors: string[]): string[] =>
	errors.filter(
		(e) =>
			!e.includes("act(") && !e.includes("favicon") && !e.includes("[vite]"),
	);

// North Melbourne — chosen because it has rich rental + sales coverage AND
// exhibits the rental/sales-aggregation divergence the mapping was built to
// solve: SAL 21966 sits in a multi-SAL rental group "North Melbourne-West
// Melbourne" (codes 21966-22757) but has its own per-SAL sales row "NORTH
// MELBOURNE". Lets us assert the "Market area: …" badge shows on Rental
// (group label differs from SAL name) and hides on Sales (matches after
// case-fold). A simpler 1:1 suburb wouldn't exercise the badge logic.
const TARGET_NAME = "North Melbourne";
const TARGET_CODE = "21966";
const TARGET_RENTAL_GROUP_LABEL = "North Melbourne-West Melbourne";

test.describe("Suburb selection", () => {
	test("selecting a suburb opens the plot panel without errors", async ({
		page,
	}) => {
		ensureDir();
		const captured = collectErrors(page);

		const persistLog = () => {
			writeFileSync(
				`${ARTIFACT_DIR}/${SLUG_LOG}.log`,
				`${captured.lines.join("\n")}\n`,
				"utf-8",
			);
		};

		try {
			// Wipe any persisted overlay theme from a previous run so we start
			// in light mode deterministically. `addInitScript` runs before
			// every navigation, so localStorage is empty when ThemeProvider
			// reads it on first mount. (Avoid `goto + reload` here — reload
			// aborts in-flight tile fetches and the "Failed to fetch" errors
			// then count against the clean-console assertion below.)
			await page.addInitScript(() => {
				try {
					window.localStorage.clear();
				} catch {
					/* private mode etc — non-fatal */
				}
			});
			await page.goto("/");

			// React mount.
			await page.waitForFunction(
				() => (document.getElementById("root")?.children.length ?? 0) > 0,
				{ timeout: 15_000 },
			);

			// Wait for the test hook to be wired up — App.tsx mounts an effect
			// that assigns `window.__htsSelectRegion` on first render.
			await page.waitForFunction(
				() =>
					typeof (window as unknown as Record<string, unknown>)
						.__htsSelectRegion === "function",
				{ timeout: 10_000 },
			);

			// Wait for DuckDB ready — otherwise the chart query will throw.
			// The Controls panel header sets a colored dot whose CSS background
			// is "#00c864" once status === "ready". Easier to just wait for the
			// initial network bursts to settle. The SAL layer is no longer
			// default-visible, so we don't poll `__htsTileCount("suburbs-sal")`
			// here any more — selection is driven by the programmatic test
			// hook below, which doesn't depend on the SAL layer rendering.
			await page
				.waitForLoadState("networkidle", { timeout: 15_000 })
				.catch(() => {});

			// Drive selection programmatically. Pass `kind: "suburb"` because
			// this test exercises the SAL → suburb plot path; an LGA-flavoured
			// counterpart would pass `kind: "lga"` with an LGA_CODE24.
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

			// Plot panel renders bottom-center after selection. Header includes
			// "SAL <code>". Wait up to 15s — Plotly's lazy chunk download +
			// DuckDB query both need to complete.
			const panel = page.locator('aside:has-text("SAL")').first();
			await panel.waitFor({ state: "visible", timeout: 15_000 });

			// Wait for Plotly's chart SVG to actually be in the DOM. `.main-svg`
			// is Plotly's root chart-element class. Without this wait the
			// screenshot captures the "Loading…" placeholder, which is useless
			// as visual evidence. If this never appears something is silently
			// stuck inside Plotly's render — that's a real failure to surface.
			//
			// Generous timeout: with 5 default-visible layers (suburbs + iso5/15
			// + 3 line layers) the initial tile-fetch burst competes with
			// Plotly's ~700KB lazy chunk, which on a cold cache can take 10s+.
			const chartSvg = panel.locator(".main-svg").first();
			await chartSvg.waitFor({ state: "visible", timeout: 30_000 });

			// Default view is Rental. Snapshot it.
			const rentalTab = panel.getByRole("button", { name: /^Rental/ });
			const salesTab = panel.getByRole("button", { name: /^Sales/ });
			await expect(rentalTab).toBeVisible();
			await expect(salesTab).toBeVisible();
			await expect(rentalTab).toHaveAttribute("aria-pressed", "true");

			// "Market area" badge — proves the suburb-mappings JSON loaded and
			// the multi-SAL rental group label is being surfaced. North Melbourne
			// rolls up with West Melbourne for rent surveys, so the rental view
			// must display the joined label.
			await expect(panel).toContainText(TARGET_RENTAL_GROUP_LABEL);
			await expect(panel).toContainText("(2 SALs)");

			await page.screenshot({
				path: `${ARTIFACT_DIR}/${SLUG_RENTAL}.png`,
				fullPage: true,
			});

			// Capture rental y-axis title text — used to confirm the chart
			// actually re-renders after we toggle to Sales (titles differ).
			const rentalYAxisTitle = await panel
				.locator(".main-svg .ytitle")
				.first()
				.textContent();
			expect(rentalYAxisTitle).toContain("rent");

			// Toggle to Sales. The chart should re-render with a different
			// y-axis title and the aria-pressed flips.
			await salesTab.click();
			await expect(salesTab).toHaveAttribute("aria-pressed", "true");
			// Wait for the y-axis title to actually update — Plotly re-renders
			// asynchronously, so we poll on the visible text rather than racing.
			await expect
				.poll(
					async () =>
						(
							await panel.locator(".main-svg .ytitle").first().textContent()
						)?.toLowerCase() ?? "",
					{ timeout: 5_000 },
				)
				.toContain("sale price");

			// On Sales view the multi-SAL rental group label must NOT appear.
			// Sales for North Melbourne (21966) is per-SAL "NORTH MELBOURNE",
			// which case-folds to the SAL name, so the badge hides.
			await expect(panel).not.toContainText(TARGET_RENTAL_GROUP_LABEL);

			await page.screenshot({
				path: `${ARTIFACT_DIR}/${SLUG_SALES}.png`,
				fullPage: true,
			});

			// The panel should display the suburb name we selected.
			await expect(panel).toContainText(TARGET_NAME);
			await expect(panel).toContainText(`SAL ${TARGET_CODE}`);

			// --- Light theme flip -------------------------------------------
			// Default is dark, so the panel should already carry `.dark` and
			// the toggle's accessible name should be the *target* state
			// "Switch to light mode". Clicking it removes `.dark`.
			await expect(panel).toHaveClass(/(^|\s)dark(\s|$)/);
			const toggle = page.getByRole("button", {
				name: "Switch to light mode",
			});
			await expect(toggle).toBeVisible();
			await toggle.click();
			// After flip, the button label points back to dark.
			await expect(
				page.getByRole("button", { name: "Switch to dark mode" }),
			).toBeVisible();
			// And the `.dark` class is gone from the plot panel.
			await expect(panel).not.toHaveClass(/(^|\s)dark(\s|$)/);

			await page.screenshot({
				path: `${ARTIFACT_DIR}/${SLUG_LIGHT}.png`,
				fullPage: true,
			});

			// Fail loudly if the ErrorBoundary fallback was rendered.
			const errorBanner = await page.locator('text="Render error:"').count();
			expect(errorBanner, "ErrorBoundary fallback rendered").toBe(0);

			// Browser console should be clean.
			const real = filterRealErrors(captured.errors);
			expect(real, `Browser console errors:\n${real.join("\n")}`).toHaveLength(
				0,
			);
		} finally {
			persistLog();
		}
	});
});
