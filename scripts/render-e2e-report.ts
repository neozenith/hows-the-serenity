#!/usr/bin/env bun
/**
 * Render e2e-screenshots/ artifacts into a single review markdown.
 *
 * For each test (identified by a .log file stem) emits a section with:
 *   - heading (humanised slug)
 *   - the full-page screenshot (and any stem-*.png variant siblings)
 *   - the console log in a fenced block
 *   - the network timeline as a mermaid gantt
 *
 * The gantt defaults to the 30 slowest requests per test (chronologically
 * ordered within `resource_type` sections). Pass --all to include every
 * request — handy when investigating a specific slow page.
 *
 * Usage:
 *   bun run scripts/render-e2e-report.ts            # top 30, default output
 *   bun run scripts/render-e2e-report.ts --all      # every request
 *   bun run scripts/render-e2e-report.ts --limit 50
 *   bun run scripts/render-e2e-report.ts --out tmp/e2e-report.md
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

interface NetworkRequest {
	url: string;
	method: string;
	status: number;
	start_offset_ms: number;
	duration_ms: number;
	resource_type: string;
}

interface NetworkData {
	test_start_ms: number;
	wall_clock_duration_ms: number;
	total_requests: number;
	total_duration_ms: number;
	all_requests: NetworkRequest[];
}

interface TestArtifacts {
	stem: string;
	logFile: string;
	primaryPng?: string;
	variantPngs: string[];
	networkFile?: string;
}

const SCREENSHOTS_DIR = "e2e-screenshots";

const titleCase = (s: string): string =>
	s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

const humanise = (stem: string): string => {
	const routeMatch = stem.match(/^E\d+_([A-Z0-9_]+)-S\d+_([A-Z0-9_]+)$/);
	if (routeMatch) {
		const [, engine = "", section = ""] = routeMatch;
		return `${titleCase(engine)} · ${titleCase(section.replace(/_/g, " "))}`;
	}
	return stem.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
};

const escapeMermaidName = (raw: string): string =>
	raw
		.replace(/:/g, "—")
		.replace(/`/g, "")
		.replace(/#/g, "")
		.replace(/,/g, ";")
		.slice(0, 80);

const urlToTaskName = (url: string): string => {
	try {
		const u = new URL(url);
		const path = u.pathname + (u.search || "");
		return escapeMermaidName(path || "/");
	} catch {
		return escapeMermaidName(url);
	}
};

const groupArtifacts = async (
	dir: string,
): Promise<{ tests: TestArtifacts[]; orphanPngs: string[] }> => {
	const entries = await readdir(dir);
	const logs = entries.filter((e) => e.endsWith(".log")).sort();
	const pngs = new Set(entries.filter((e) => e.endsWith(".png")));
	const networkJsons = new Set(
		entries.filter((e) => e.endsWith(".network.json")),
	);

	const claimed = new Set<string>();
	const tests: TestArtifacts[] = [];
	for (const log of logs) {
		const stem = log.replace(/\.log$/, "");
		const primary = `${stem}.png`;
		const variantPngs: string[] = [];
		for (const png of pngs) {
			if (png === primary) continue;
			if (png.startsWith(`${stem}-`)) {
				variantPngs.push(png);
				claimed.add(png);
			}
		}
		if (pngs.has(primary)) claimed.add(primary);
		const networkFile = `${stem}.network.json`;
		const hasNetwork = networkJsons.has(networkFile);
		if (hasNetwork) claimed.add(networkFile);

		tests.push({
			stem,
			logFile: log,
			primaryPng: pngs.has(primary) ? primary : undefined,
			variantPngs: variantPngs.sort(),
			networkFile: hasNetwork ? networkFile : undefined,
		});
	}

	const orphanPngs = [...pngs].filter((p) => !claimed.has(p)).sort();
	return { tests, orphanPngs };
};

const renderGantt = (
	data: NetworkData,
	limit: number | null,
): { mermaid: string; shown: number; total: number } => {
	const all = data.all_requests;
	const ranked = [...all].sort((a, b) => b.duration_ms - a.duration_ms);
	const selected = limit == null ? all : ranked.slice(0, limit);
	const selectedSet = new Set(selected);

	const chronological = all
		.filter((r) => selectedSet.has(r))
		.sort((a, b) => a.start_offset_ms - b.start_offset_ms);

	const bySection = new Map<string, NetworkRequest[]>();
	for (const r of chronological) {
		const k = r.resource_type || "other";
		const bucket = bySection.get(k) ?? [];
		bucket.push(r);
		bySection.set(k, bucket);
	}

	const lines: string[] = [
		"```mermaid",
		"gantt",
		`    title Network Timeline · wall-clock ${data.wall_clock_duration_ms} ms · ${data.total_requests} requests`,
		"    dateFormat x",
		"    axisFormat %M:%S",
		"    todayMarker off",
	];
	for (const [section, reqs] of bySection) {
		lines.push(`    section ${escapeMermaidName(section)}`);
		for (const r of reqs) {
			const name = urlToTaskName(r.url);
			const start = Math.max(0, r.start_offset_ms);
			const end = start + Math.max(1, r.duration_ms);
			lines.push(`    ${name} :${start}, ${end}`);
		}
	}
	lines.push("```");

	return {
		mermaid: lines.join("\n"),
		shown: chronological.length,
		total: all.length,
	};
};

const renderTestSection = async (
	dir: string,
	test: TestArtifacts,
	limit: number | null,
): Promise<string> => {
	const blocks: string[] = [
		`## ${humanise(test.stem)}`,
		"",
		`**Slug:** \`${test.stem}\``,
		"",
	];

	if (test.primaryPng) {
		blocks.push(`![${test.stem}](${test.primaryPng})`, "");
	}
	for (const v of test.variantPngs) {
		blocks.push(`![${v}](${v})`, "");
	}

	const logText = await readFile(join(dir, test.logFile), "utf8");
	blocks.push(
		"### Console log",
		"",
		"```log",
		logText.trimEnd() || "(empty)",
		"```",
		"",
	);

	if (test.networkFile) {
		const raw = await readFile(join(dir, test.networkFile), "utf8");
		const data = JSON.parse(raw) as NetworkData;
		blocks.push(
			"### Network timeline",
			"",
			`- wall-clock duration: ${data.wall_clock_duration_ms} ms`,
			`- summed request duration: ${data.total_duration_ms} ms`,
			`- total requests: ${data.total_requests}`,
			"",
		);
		const { mermaid, shown, total } = renderGantt(data, limit);
		if (limit != null && shown < total) {
			blocks.push(
				`_Showing ${shown} slowest of ${total} requests, ordered chronologically within \`resource_type\`. Re-run with \`--all\` for the full timeline._`,
				"",
			);
		}
		blocks.push(mermaid, "");
	}

	return blocks.join("\n");
};

const printHelp = (): void => {
	console.log(
		[
			"Usage: bun run scripts/render-e2e-report.ts [options]",
			"",
			"Render every test artifact in e2e-screenshots/ into a single review markdown.",
			"",
			"Options:",
			"  --all         Include every network request in each gantt",
			"  --limit N     Top-N slowest requests per test (default 30)",
			"  --out PATH    Output markdown path (default e2e-screenshots/REPORT.md)",
			"  -h, --help    Show this help and exit",
		].join("\n"),
	);
};

const main = async (): Promise<void> => {
	const { values } = parseArgs({
		args: process.argv.slice(2),
		options: {
			all: { type: "boolean", default: false },
			limit: { type: "string", default: "30" },
			out: { type: "string", default: join(SCREENSHOTS_DIR, "REPORT.md") },
			help: { type: "boolean", short: "h", default: false },
		},
		strict: true,
	});

	if (values.help) {
		printHelp();
		return;
	}

	const limit = values.all ? null : Number.parseInt(values.limit as string, 10);
	if (limit !== null && (!Number.isFinite(limit) || limit <= 0)) {
		console.error(
			`error: --limit must be a positive integer, got '${values.limit}'`,
		);
		process.exit(2);
	}

	const { tests, orphanPngs } = await groupArtifacts(SCREENSHOTS_DIR);
	if (tests.length === 0 && orphanPngs.length === 0) {
		console.error(
			`error: no artifacts found in ${SCREENSHOTS_DIR}/ — run \`make test-e2e\` first`,
		);
		process.exit(1);
	}

	const sections: string[] = [
		"# E2E Test Report",
		"",
		`_Generated ${new Date().toISOString()} · ${tests.length} test${tests.length === 1 ? "" : "s"}${
			orphanPngs.length
				? ` · ${orphanPngs.length} orphan screenshot${orphanPngs.length === 1 ? "" : "s"}`
				: ""
		}_`,
		"",
	];

	const rendered = await Promise.all(
		tests.map((t) => renderTestSection(SCREENSHOTS_DIR, t, limit)),
	);
	sections.push(...rendered);

	if (orphanPngs.length > 0) {
		sections.push("## Unattached screenshots", "");
		for (const png of orphanPngs) {
			sections.push(`![${png}](${png})`, "");
		}
	}

	const out = values.out as string;
	await writeFile(out, sections.join("\n"), "utf8");
	console.log(
		`wrote ${out} (${tests.length} tests, ${orphanPngs.length} orphan PNG${orphanPngs.length === 1 ? "" : "s"})`,
	);
};

main().catch((err: unknown) => {
	const msg = err instanceof Error ? err.message : String(err);
	console.error(`error: ${msg}`);
	process.exit(1);
});
