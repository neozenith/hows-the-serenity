import type { RegionKind } from "./rental-sales-query";

// User-selected region from the map — drives the SuburbPlotPanel and the
// rental-sales query. `kind` is the discriminator between SAL (suburb) and
// LGA tiers; `code` is the natural key used by the DuckDB query.
export type RegionSelection = {
	kind: RegionKind;
	name: string;
	code: string;
};
