import { useOverlayTheme } from "@/lib/theme";

// Single-button overlay-theme toggle. Renders the icon for the *target*
// state — i.e., a moon when the user is in light mode (clicking goes to
// dark) and a sun when in dark mode (clicking goes to light). This matches
// macOS / iOS / GitHub conventions where the icon previews the action.
//
// Inline SVGs rather than unicode glyphs to dodge the emoji-presentation
// pitfall: ☀ / ☾ render as colour emoji on macOS Safari/Chrome unless
// you append a U+FE0E variation selector. SVGs are always glyph-true and
// inherit `currentColor` so dark/light mode automatically tints them.

const SunIcon = ({ className = "h-3.5 w-3.5" }: { className?: string }) => (
	<svg
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth="2"
		strokeLinecap="round"
		strokeLinejoin="round"
		className={className}
		aria-hidden="true"
	>
		<title>Sun</title>
		<circle cx="12" cy="12" r="4" />
		<path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
	</svg>
);

const MoonIcon = ({ className = "h-3.5 w-3.5" }: { className?: string }) => (
	<svg
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth="2"
		strokeLinecap="round"
		strokeLinejoin="round"
		className={className}
		aria-hidden="true"
	>
		<title>Moon</title>
		<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
	</svg>
);

export const ThemeToggle = () => {
	const { theme, toggleTheme } = useOverlayTheme();
	const targetLabel =
		theme === "light" ? "Switch to dark mode" : "Switch to light mode";
	return (
		<button
			type="button"
			onClick={toggleTheme}
			aria-label={targetLabel}
			title={targetLabel}
			className="cursor-pointer rounded px-1.5 py-0.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
		>
			{theme === "light" ? <MoonIcon /> : <SunIcon />}
		</button>
	);
};
