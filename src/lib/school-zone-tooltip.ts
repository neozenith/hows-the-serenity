// Pure tooltip formatter for school-zone polygon picks.
//
// Each picked feature carries the props the extract step preserved
// (KEEP_PROPERTIES in etl/steps/extract_school_zones.py):
//   - School_Name, Campus_Name, ENTITY_CODE, Year_Level, Boundary_Year
//   - level (the per-level slug we derive from the source filename)
//
// We return: a friendly per-level layer label as the top line, then
// the polygon identifier (school name + ENTITY_CODE) below. Returns
// null when the props don't look like a school-zone feature so the
// caller can fall through to other layer types.

const LEVEL_LABEL: Record<string, string> = {
	primary: "Primary school zone",
	secondary_year7: "Secondary year 7 zone",
	secondary_year8: "Secondary year 8 zone",
	secondary_year9: "Secondary year 9 zone",
	secondary_year10: "Secondary year 10 zone",
	secondary_year11: "Secondary year 11 zone",
	secondary_year12: "Secondary year 12 zone",
	standalone_juniorsec: "Standalone junior-sec zone",
	standalone_seniorsec: "Standalone senior-sec zone",
	standalone_singlesex: "Standalone single-sex zone",
};

// Fallback when an unrecognised level slug arrives (e.g. a new
// vendor-shipped year not yet in the LEVEL_LABEL map). We still want
// to surface something useful instead of returning null.
const prettifyLevel = (slug: string): string =>
	slug
		.split("_")
		.map((tok) => tok.charAt(0).toUpperCase() + tok.slice(1))
		.join(" ");

export const schoolZoneTooltip = (
	props: Record<string, unknown> | null | undefined,
): string | null => {
	if (!props) return null;
	const level = typeof props.level === "string" ? props.level : null;
	const schoolName =
		typeof props.School_Name === "string" ? props.School_Name : null;
	const entity =
		typeof props.ENTITY_CODE === "number"
			? String(props.ENTITY_CODE)
			: typeof props.ENTITY_CODE === "string"
				? props.ENTITY_CODE
				: null;
	// Need at least one school-zone-shaped property to classify the pick.
	if (!level && !schoolName) return null;

	const lines: string[] = [];
	if (level) lines.push(LEVEL_LABEL[level] ?? prettifyLevel(level));
	if (schoolName && entity) lines.push(`${schoolName} (${entity})`);
	else if (schoolName) lines.push(schoolName);
	else if (entity) lines.push(`Entity ${entity}`);
	return lines.length > 0 ? lines.join("\n") : null;
};
