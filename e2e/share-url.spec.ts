import { expect, type Page, test } from "@playwright/test";

/**
 * Shareable map URL: the address bar carries the camera (`?v=`) and the
 * active layers (`?l=`), a pasted link restores both, and moving or toggling
 * rewrites the link live.
 */

const params = (page: Page): URLSearchParams =>
	new URLSearchParams(new URL(page.url()).search);

test("a shared link restores camera and layers, then tracks changes", async ({
	page,
}) => {
	await page.goto("/?v=-37.8,145.0,12.50,30,90&l=lga,tileGrid");
	await page.getByRole("button", { name: "Show controls" }).first().click();

	// Layers: exactly the linked set is on.
	const tileGrid = page.getByLabel("Tile grid (debug)");
	await expect(tileGrid).toBeChecked();
	await expect(page.getByLabel("Suburb boundaries")).not.toBeChecked();

	// Camera: the header readout reflects the linked pose, not the default.
	await expect(page.getByText("z 12.5", { exact: true })).toBeVisible();
	await expect(page.getByText("p 30°", { exact: true })).toBeVisible();
	await expect(page.getByText("b 90°", { exact: true })).toBeVisible();

	// The link survives mount untouched (canonical form round-trips).
	await expect.poll(() => params(page).get("l")).toBe("lga,tileGrid");
	expect(params(page).get("v")).toBe("-37.8,145,12.50,30,90");

	// Toggling a layer rewrites `l` immediately.
	await tileGrid.uncheck();
	await expect.poll(() => params(page).get("l")).toBe("lga");

	// Panning rewrites `v` once the debounce settles.
	const canvas = page.locator("#deckgl-overlay");
	const box = await canvas.boundingBox();
	if (!box) throw new Error("deck.gl canvas not laid out");
	const cx = box.x + box.width * 0.7;
	const cy = box.y + box.height / 2;
	await page.mouse.move(cx, cy);
	await page.mouse.down();
	await page.mouse.move(cx - 200, cy + 120, { steps: 10 });
	await page.mouse.up();
	await expect
		.poll(() => params(page).get("v"))
		.not.toBe("-37.8,145,12.50,30,90");
	expect(params(page).get("v")).toMatch(/^-?[\d.]+,-?[\d.]+,12\.50,30,90$/);

	// Reloading the rewritten link reproduces the same view.
	const shared = page.url();
	await page.goto(shared);
	await page.getByRole("button", { name: "Show controls" }).first().click();
	await expect(page.getByLabel("Tile grid (debug)")).not.toBeChecked();
	await expect.poll(() => page.url()).toBe(shared);
});
