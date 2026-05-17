// Ambient declaration for cytoscape-dagre. The package ships a CJS
// extension entry with no type definitions and there is no
// @types/cytoscape-dagre on npm; the only API surface we use is the
// default export passed to `cytoscape.use()`, so a minimal module shim
// is enough to keep TypeScript happy without leaking `any` everywhere.

declare module "cytoscape-dagre" {
	import type { Ext } from "cytoscape";

	const ext: Ext;
	export default ext;
}
