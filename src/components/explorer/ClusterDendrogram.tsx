// Cytoscape.js dendrogram for /explore/dendrogram/:tier.
//
// Two render modes:
//   - HDBSCAN method → condensed-tree rendering (the project's faithful
//     recreation of `hdbscan.plots.CondensedTree.plot()`). Per-edge
//     minLen encodes the child cluster's λ-persistence so stable
//     clusters appear as long trunks, faithful to the HDBSCAN
//     convention. See docs/specs/hdbscan_condensed_dendrogram.md.
//   - EVoC method → raw n-ary cluster_tree_ (already "condensed in
//     spirit" by EVoC; no further condensation makes sense).
//
// In both modes the root sits at the top via cytoscape-dagre's
// `rankDir: 'TB'`; node width/height and edge stroke width scale with
// the subtree polygon count (the existing sizeToNodeRadius helper).

import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import dagre from "cytoscape-dagre";
import { useEffect, useMemo, useRef, useState } from "react";

import {
	linkageRowsToCytoElements,
	sizeToEdgeWidth,
	sizeToNodeRadius,
} from "@/lib/cluster-dendrogram";
import {
	condensedTreeToCytoElements,
	condenseLinkageTree,
} from "@/lib/hdbscan-condensed";
import {
	type ClusterLinkageNode,
	type ClusterMethod,
	type ClusterTier,
	queryClusterLinkage,
} from "@/lib/rental-sales-query";

// Register the dagre layout exactly once per module load.
let _dagreRegistered = false;
const ensureDagre = (): void => {
	if (_dagreRegistered) return;
	(cytoscape as unknown as { use: (ext: unknown) => void }).use(dagre);
	_dagreRegistered = true;
};

const METHODS: ReadonlyArray<{ id: ClusterMethod; label: string }> = [
	{ id: "hdbscan", label: "HDBSCAN (condensed)" },
	{ id: "evoc", label: "EVoC" },
];

// Sensible min_cluster_size choices for the analyst — small enough to
// see fine structure on a 79-LGA tree, large enough to collapse noise
// on a 760-SAL tree without losing all the splits.
const MIN_CLUSTER_SIZE_CHOICES = [2, 5, 10, 20] as const;

// How many pixels of dagre rank-space one unit of Δλ should buy. Tuned
// so the largest Δλ in the tree resolves to ~30-60 rank units against
// the project's `rankSep: 10`, giving a ~300-600 px tall dendrogram for
// the most stable clusters — within the 480 px canvas, scrollable below.
const LAMBDA_PIXEL_SCALE = 40;
const MAX_MIN_LEN = 30;

export const ClusterDendrogram = ({
	tier,
	method,
	onMethodChange,
}: {
	tier: ClusterTier;
	method: ClusterMethod;
	onMethodChange: (next: ClusterMethod) => void;
}) => {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const cyRef = useRef<Core | null>(null);
	const [rows, setRows] = useState<ClusterLinkageNode[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [minClusterSize, setMinClusterSize] = useState<number>(5);

	useEffect(() => {
		setRows(null);
		setError(null);
		let cancelled = false;
		queryClusterLinkage(tier, method)
			.then((r) => {
				if (!cancelled) setRows(r);
			})
			.catch((err: unknown) => {
				if (!cancelled) {
					setError(err instanceof Error ? err.message : String(err));
					setRows([]);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [tier, method]);

	// Condensed-tree mode (HDBSCAN) — derive minLen-aware Cytoscape
	// elements. EVoC mode — fall back to the existing n-ary renderer
	// since EVoC's tree is already a high-level cluster tree.
	const elements: ElementDefinition[] = useMemo(() => {
		if (!rows) return [];
		if (method === "hdbscan") {
			const condensed = condenseLinkageTree(rows, minClusterSize);
			return condensedTreeToCytoElements(condensed, {
				lambdaPixelScale: LAMBDA_PIXEL_SCALE,
				// Cap rank-span: dagre allocates a dummy node per rank,
				// so an unclamped minLen of ~500 explodes the call stack
				// inside successors(). 30 rank-levels × rankSep=10px = 300px
				// max vertical gap per edge — plenty of visual range.
				maxMinLen: MAX_MIN_LEN,
			}) as ElementDefinition[];
		}
		return linkageRowsToCytoElements(rows) as ElementDefinition[];
	}, [rows, method, minClusterSize]);

	const maxSize = useMemo(() => {
		if (elements.length === 0) return 1;
		return elements.reduce((m, el) => {
			if (el.group !== "nodes") return m;
			const data = el.data as { size?: number; sizeAtBirth?: number };
			const s = data.sizeAtBirth ?? data.size ?? 1;
			return s > m ? s : m;
		}, 1);
	}, [elements]);

	useEffect(() => {
		ensureDagre();
		if (!containerRef.current || elements.length === 0) return;
		const cy = cytoscape({
			container: containerRef.current,
			elements,
			minZoom: 0.05,
			maxZoom: 2,
			wheelSensitivity: 0.2,
			style: [
				{
					selector: "node",
					style: {
						"background-color": "#6366f1",
						"border-color": "#312e81",
						"border-width": 1,
						label: "data(label)",
						"font-size": 8,
						color: "#1f2937",
						"text-valign": "center",
						"text-halign": "center",
						"text-outline-color": "#ffffff",
						"text-outline-width": 1,
						width: (n: cytoscape.NodeSingular): number => {
							const s =
								(n.data("sizeAtBirth") as number | undefined) ??
								(n.data("size") as number | undefined) ??
								1;
							return sizeToNodeRadius(s, maxSize);
						},
						height: (n: cytoscape.NodeSingular): number => {
							const s =
								(n.data("sizeAtBirth") as number | undefined) ??
								(n.data("size") as number | undefined) ??
								1;
							return sizeToNodeRadius(s, maxSize);
						},
					},
				},
				{
					selector: "node[?isLeaf]",
					style: {
						"background-color": "#10b981",
						"border-color": "#064e3b",
						shape: "round-rectangle",
					},
				},
				{
					selector: "edge",
					style: {
						"curve-style": "bezier",
						"target-arrow-shape": "none",
						"line-color": "#94a3b8",
						width: (e: cytoscape.EdgeSingular): number => {
							const s =
								(e.data("weight") as number | undefined) ??
								(e.data("deltaLambda") as number | undefined) ??
								1;
							return sizeToEdgeWidth(s, maxSize);
						},
						opacity: 0.7,
					},
				},
			],
			// dagre options (rankDir / nodeSep / rankSep / per-edge minLen)
			// aren't in @types/cytoscape's ambient declarations, so the
			// literal is cast through `unknown`. rankSep stays small so
			// per-edge minLen (the condensed-tree's Δλ) resolves to visible
			// pixel gaps.
			layout: {
				name: "dagre",
				rankDir: "TB",
				nodeSep: 8,
				rankSep: method === "hdbscan" ? 10 : 60,
				edgeSep: 4,
				animate: false,
				fit: true,
				padding: 24,
				minLen: (edge: cytoscape.EdgeSingular) => {
					const m = edge.data("minLen") as number | undefined;
					return m ?? 1;
				},
			} as unknown as cytoscape.LayoutOptions,
		});
		cyRef.current = cy;
		return () => {
			cy.destroy();
			cyRef.current = null;
		};
	}, [elements, maxSize, method]);

	const nodeCount =
		method === "hdbscan"
			? elements.filter((e) => e.group === "nodes").length
			: (rows?.length ?? 0);
	const leafCount = rows?.filter((r) => r.isLeaf).length ?? 0;

	return (
		<section
			data-testid="cluster-dendrogram"
			className="rounded-md border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900"
		>
			<header className="mb-3 flex flex-wrap items-center justify-between gap-2 border-neutral-200 border-b pb-2 dark:border-neutral-800">
				<div className="flex items-baseline gap-3">
					<h2 className="font-medium text-neutral-800 text-sm dark:text-neutral-100">
						Centroid clustering — {tier.toUpperCase()}
					</h2>
					<span className="text-neutral-500 text-xs dark:text-neutral-400">
						{nodeCount.toLocaleString()} cluster nodes ·{" "}
						{leafCount.toLocaleString()} input polygons · root at top
					</span>
				</div>
				<div className="flex flex-wrap items-center gap-3 text-xs">
					{method === "hdbscan" && (
						<div
							data-testid="cluster-dendrogram-min-cluster-size"
							className="flex items-center gap-1.5"
						>
							<span className="text-neutral-500 dark:text-neutral-400">
								min_cluster_size:
							</span>
							{MIN_CLUSTER_SIZE_CHOICES.map((n) => {
								const active = n === minClusterSize;
								return (
									<button
										type="button"
										key={n}
										onClick={() => setMinClusterSize(n)}
										aria-pressed={active}
										data-testid={`cluster-dendrogram-min-${n}`}
										className={[
											"rounded px-2 py-1",
											active
												? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
												: "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800",
										].join(" ")}
									>
										{n}
									</button>
								);
							})}
						</div>
					)}
					<div
						data-testid="cluster-dendrogram-methods"
						className="flex items-center gap-1.5"
					>
						<span className="text-neutral-500 dark:text-neutral-400">
							Method:
						</span>
						{METHODS.map((m) => {
							const active = m.id === method;
							return (
								<button
									type="button"
									key={m.id}
									onClick={() => onMethodChange(m.id)}
									aria-pressed={active}
									data-testid={`cluster-dendrogram-method-${m.id}`}
									className={[
										"rounded px-2 py-1",
										active
											? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
											: "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800",
									].join(" ")}
								>
									{m.label}
								</button>
							);
						})}
					</div>
				</div>
			</header>
			{error ? (
				<p
					className="text-red-600 text-sm dark:text-red-300"
					data-testid="cluster-dendrogram-error"
				>
					{error}
				</p>
			) : rows === null ? (
				<p
					className="text-neutral-500 text-sm"
					data-testid="cluster-dendrogram-loading"
				>
					Loading {tier.toUpperCase()} {method.toUpperCase()} dendrogram…
				</p>
			) : (
				<div
					ref={containerRef}
					data-testid="cluster-dendrogram-canvas"
					className="h-[480px] w-full overflow-hidden rounded-sm bg-neutral-50 dark:bg-neutral-950"
				/>
			)}
		</section>
	);
};
