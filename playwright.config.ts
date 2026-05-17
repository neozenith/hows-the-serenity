import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the project's e2e suite.
 *
 * The dev server is started by Playwright's `webServer` block on the agentic
 * port (5174) so a human running `make dev` on 5173 can keep working while
 * `make test-e2e` runs in parallel without port collisions.
 */

const PORT = Number(process.env.PLAYWRIGHT_PORT ?? 5174);
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${PORT}`;
// When pointed at a remote URL (e.g. the live Pages deploy for
// post-deploy verification), skip the dev-server bootstrap — there's no
// local server to start and `webServer` would block on a localhost
// port that no one's serving.
const IS_REMOTE_TARGET = !BASE_URL.startsWith("http://localhost");

export default defineConfig({
	testDir: "./e2e",
	// Bumped 180s → 300s as the bundle grew further (school-zone tile
	// layers + yield-ratio + Models tab + cluster_linkage). On CI the
	// SuburbPlot lazy chunk + the DuckDB-WASM split chunk + Plotly each
	// add a serial fetch; cold-load to first .main-svg can run >90s.
	timeout: 300_000,
	// 30s expect default (up from 10s) — covers the asynchronous
	// suburb-mappings JSON fetch + chunk-load cascade. Per-assertion
	// overrides still apply where finer-grained control is needed.
	expect: { timeout: 30_000 },
	fullyParallel: true,
	forbidOnly: Boolean(process.env.CI),
	retries: process.env.CI ? 2 : 0,
	workers: process.env.CI ? 1 : undefined,
	reporter: [["list"], ["html", { open: "never" }]],
	outputDir: "test-results",
	use: {
		baseURL: BASE_URL,
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
		video: "retain-on-failure",
	},
	projects: [
		{
			name: "default",
			use: { ...devices["Desktop Chrome"] },
		},
	],
	webServer: IS_REMOTE_TARGET
		? undefined
		: {
				command: `bun run dev -- --port ${PORT} --strictPort`,
				url: BASE_URL,
				reuseExistingServer: !process.env.CI,
				timeout: 120_000,
			},
});
