// Pure helper backing the Deck.GL hover-tooltip on /explore/overview's
// TierPolygonMap. Takes the tier and a feature's properties bag and
// returns the display label (or null if the feature isn't shaped like
// the tier expects, so the caller can suppress the tooltip).

import type { RegionTier } from "@/lib/overview-summary";

const CODE_FIELD: Record<RegionTier, string> = {
	sal: "SAL_CODE21",
	lga: "LGA_CODE24",
};

const NAME_FIELD: Record<RegionTier, string> = {
	sal: "SAL_NAME21",
	lga: "LGA_NAME24",
};

const stringOrNull = (v: unknown): string | null =>
	typeof v === "string" && v.length > 0 ? v : null;

export const polygonHoverLabel = (
	tier: RegionTier,
	properties: Record<string, unknown> | null | undefined,
): string | null => {
	if (!properties) return null;
	const code = stringOrNull(properties[CODE_FIELD[tier]]);
	const name = stringOrNull(properties[NAME_FIELD[tier]]);
	if (!code && !name) return null;
	if (code && name) return `${code} — ${name}`;
	return code ?? name;
};
