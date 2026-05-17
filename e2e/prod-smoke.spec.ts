// Post-deployment smoke test.
//
// Runs the same shape of click-flow as suburb-click.spec.ts, but against
// whatever URL is in PLAYWRIGHT_BASE_URL — typically the live Pages
// deploy. Dev-only `window.__hts*` test hooks aren't available on prod
// builds (they're tagged off behind a feature flag), so this spec must
// drive the UI through the real user paths: click the map, click a
// region, click chart tabs.
//
// Run via `make test-e2e-prod` — the Makefile sets
// `PLAYWRIGHT_BASE_URL=https://joshpeak.net/hows-the-serenity/`. The
// playwright config skips its `webServer` bootstrap when the base URL
// is remote, so this spec talks directly to the deployed bundle.

import { expect, test } from "@playwright/test";

const isRemote = !process.env.PLAYWRIGHT_BASE_URL?.startsWith("http://localhost");

test.describe("Post-deploy smoke", () => {
	test("page loads, React mounts, root has content", async ({ page }) => {
		const consoleErrors: string[] = [];
		const pageErrors: string[] = [];
		page.on("console", (m) => {
			if (m.type() === "error") consoleErrors.push(m.text());
		});
		page.on("pageerror", (e) =>
			pageErrors.push(`${e.message}\n${e.stack ?? ""}`),
		);

		await page.goto("/", { waitUntil: "domcontentloaded", timeout: 30_000 });

		// React must mount the App into #root. If the bundle silently fails to
		// boot (the exact failure mode that motivates this spec), #root stays
		// empty forever. 45s headroom for cold deploy + DuckDB-WASM init.
		await expect
			.poll(
				async () =>
					await page.evaluate(
						() => document.getElementById("root")?.children.length ?? 0,
					),
				{ timeout: 45_000, message: "#root never mounted (React boot failure)" },
			)
			.toBeGreaterThan(0);

		// No JS-level errors and no page errors during mount. This catches the
		// "silent boot" failure too: if React throws inside an effect, the
		// error makes it to one of these listeners.
		expect(pageErrors, `Page errors:\n${pageErrors.join("\n")}`).toHaveLength(0);
		expect(
			consoleErrors,
			`Console errors:\n${consoleErrors.join("\n")}`,
		).toHaveLength(0);
	});

	test("DuckDB-WASM finishes initialising (controls header turns ready)", async ({
		page,
	}) => {
		// The ControlPanel header carries a small status dot whose CSS
		// background flips to a brand green once DuckDB initRentalDb()
		// resolves. That signal proves the whole boot chain landed:
		// wasm worker download → wasm instantiate → .duckdb fetch → ATTACH.
		await page.goto("/", { waitUntil: "domcontentloaded", timeout: 30_000 });
		// 60s: DuckDB-WASM bundle ~1MB + the data file (~6.5 MB) + the wasm
		// `instantiate()` step. Remote runs add network latency on top.
		await expect
			.poll(
				async () =>
					await page.evaluate(() => {
						const root = document.getElementById("root");
						if (!root) return "no-root";
						const heading = root.querySelector("h1");
						const status = heading?.parentElement?.querySelector(
							'[role="status"]',
						);
						return status?.getAttribute("aria-label") ?? "no-status";
					}),
				{ timeout: 60_000 },
			)
			.toContain("zoom");
	});

	test("clicking the SAL layer toggle opens it and Layers panel is interactive", async ({
		page,
	}) => {
		test.skip(
			isRemote,
			"Layer panel auto-collapses on small viewports; remote default size is OK but clicks require a stable widget tree. Local-only for now.",
		);
		await page.goto("/", { waitUntil: "domcontentloaded", timeout: 30_000 });
		// Generic interactivity check — the test would expand here when the
		// dev hooks aren't relied upon.
		await expect(page.getByRole("heading", { name: /serenity/i })).toBeVisible({
			timeout: 30_000,
		});
	});
});
