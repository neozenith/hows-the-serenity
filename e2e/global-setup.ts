/**
 * Fail fast if the server we're about to test isn't this app.
 *
 * `reuseExistingServer` is on outside CI, so if any other project's dev
 * server happens to be listening on the Playwright port, Playwright adopts
 * it and runs the entire suite against the wrong application. The symptom is
 * baffling — every map test times out and the console fills with 401s from
 * an API this project doesn't have — and it looks exactly like a real
 * regression. One HTTP request up front turns that into a clear error.
 */
import type { FullConfig } from "@playwright/test";

// Marker that must appear in the served HTML. index.html sets this title, so
// it is the cheapest positive identifier that survives a cold dev server.
const APP_MARKER = "How's the Serenity";

const globalSetup = async (config: FullConfig): Promise<void> => {
	const baseURL = config.projects[0]?.use?.baseURL;
	if (typeof baseURL !== "string") return;

	const res = await fetch(baseURL).catch((err: unknown) => {
		throw new Error(
			`e2e: could not reach ${baseURL} — ${err instanceof Error ? err.message : String(err)}`,
		);
	});
	const html = await res.text();
	if (html.includes(APP_MARKER)) return;

	const title = /<title>(.*?)<\/title>/.exec(html)?.[1] ?? "(no <title>)";
	throw new Error(
		[
			`e2e: ${baseURL} is not serving this app — it reports title "${title}".`,
			"",
			"Another project's dev server is squatting on the Playwright port, and",
			"reuseExistingServer adopted it. Free the port, then re-run:",
			"",
			"  make agentic-port-clean",
			"",
			"(Port comes from AGENTIC_DEV_PORT in the Makefile, forwarded as",
			"PLAYWRIGHT_PORT. Run e2e via `make test-e2e` so they stay in sync.)",
		].join("\n"),
	);
};

export default globalSetup;
