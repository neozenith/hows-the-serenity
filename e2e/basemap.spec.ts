import { expect, test } from "@playwright/test";

/**
 * Basemap smoke: MapLibre fetches vector tiles from its web worker, so a tile
 * response proves the worker booted. Deck.GL overlays render without the
 * basemap, which is how a broken worker (e.g. Vite's dep optimizer dropping
 * `maplibre-gl-worker.mjs`) slipped past every other spec.
 */
test("MapLibre basemap worker loads vector tiles", async ({ page }) => {
	const workerErrors: string[] = [];
	page.on("console", (msg) => {
		if (msg.type() === "error" && /worker/i.test(msg.text())) {
			workerErrors.push(msg.text());
		}
	});
	page.on("pageerror", (err) => {
		if (/worker/i.test(err.message)) workerErrors.push(err.message);
	});

	const tile = page.waitForResponse(
		(r) =>
			r.url().includes("cartocdn.com") && /\.(mvt|pbf)(\?|$)/.test(r.url()),
		{ timeout: 30_000 },
	);
	await page.goto("/");
	expect((await tile).ok()).toBe(true);
	expect(workerErrors).toEqual([]);
});
