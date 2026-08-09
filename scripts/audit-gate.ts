#!/usr/bin/env bun
/**
 * Strict dependency-audit gate with a documented advisory allowlist.
 *
 * `bun audit --audit-level=high` fails on ANY high+ advisory, but its
 * `--ignore` flag matches CVE ids only — and some GitHub advisories reach
 * bun's feed without a `cves` field, making them impossible to ignore even
 * when no patched release exists. This wrapper keeps the same strict policy
 * (any non-allowlisted high+ advisory fails) while allowing a reviewed,
 * justified allowlist keyed by GHSA id.
 *
 * Every allowlist entry MUST carry a written justification and should be
 * re-checked when bumping the affected dependency.
 */
// node:child_process (not Bun.$) — tsconfig.node.json types this directory
// with "node" only, matching the sibling render-e2e-report.ts script.
import { spawnSync } from "node:child_process";

/** GHSA ids allowed to pass, with justification. */
const ALLOWLIST: Record<string, string> = {
	// image-size <=2.0.2: DoS via malformed ICNS/JXL/HEIF images. No patched
	// release exists (latest IS 2.0.2). Reached only through deck.gl's
	// 3D-tiles texture pipeline (@loaders.gl/textures › texture-compressor),
	// which this app never invokes — we render MVT + GeoJSON layers only,
	// and never feed user-supplied images to it.
	"GHSA-w3rx-r6r6-pgpr":
		"image-size ICNS DoS — unused 3d-tiles path, no fix released",
	"GHSA-5p2g-fcmc-qvqq":
		"image-size JXL/HEIF DoS — unused 3d-tiles path, no fix released",
};

const SEVERITIES_GATED = new Set(["high", "critical"]);

type Advisory = {
	url?: string;
	title?: string;
	severity?: string;
};

// `bun audit --json` exits non-zero when advisories exist — that's the very
// case this gate re-evaluates, so only a missing/empty payload is fatal.
const proc = spawnSync("bun", ["audit", "--json"], { encoding: "utf8" });
if (!proc.stdout) {
	console.error(`audit-gate: bun audit produced no output: ${proc.stderr}`);
	process.exit(1);
}
const report = JSON.parse(proc.stdout) as Record<string, Advisory[]>;

let failures = 0;
for (const [pkg, advisories] of Object.entries(report)) {
	for (const adv of advisories) {
		if (!SEVERITIES_GATED.has(adv.severity ?? "")) continue;
		const ghsa = adv.url?.split("/").pop() ?? "";
		if (ALLOWLIST[ghsa]) {
			console.error(`allowlisted: ${pkg} ${ghsa} (${ALLOWLIST[ghsa]})`);
			continue;
		}
		failures += 1;
		console.error(
			`FAIL: ${pkg} [${adv.severity}] ${ghsa} — ${adv.title ?? ""}`,
		);
	}
}

if (failures > 0) {
	console.error(`audit-gate: ${failures} non-allowlisted high+ advisories`);
	process.exit(1);
}
console.error("audit-gate: OK");
