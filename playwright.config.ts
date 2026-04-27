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

export default defineConfig({
	testDir: "./e2e",
	// Bumped from 90s as the layer count grew; full-page screenshots after
	// 7 MVTLayer settling can run 60s+ on a cold dev server. Re-evaluate if
	// total runtime starts dominating CI.
	timeout: 180_000,
	expect: { timeout: 10_000 },
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
	webServer: {
		command: `bun run dev -- --port ${PORT} --strictPort`,
		url: BASE_URL,
		reuseExistingServer: !process.env.CI,
		timeout: 120_000,
	},
});
