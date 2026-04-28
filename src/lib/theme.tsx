import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useState,
} from "react";

// Overlay-only theme provider. The map (CartoDB dark-matter) is always dark;
// this controls the look of the floating widgets — controls panel, debug
// overlay, suburb plot panel — and the Plotly chart inside the panel.
//
// Persistence: localStorage so the choice survives reloads. We don't read
// `prefers-color-scheme` because the user's request is explicit: light is
// the default for high contrast against the dark map; dark is opt-in.

export type OverlayTheme = "light" | "dark";

const STORAGE_KEY = "hts:overlay-theme";
// Dark by default — the map style is dark-matter, so dark overlays blend
// in rather than punching out as bright white panels over a dark canvas.
// Users who prefer light can flip via the toggle (persists in localStorage).
const DEFAULT_THEME: OverlayTheme = "dark";

type ThemeContextValue = {
	theme: OverlayTheme;
	setTheme: (t: OverlayTheme) => void;
	toggleTheme: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

const readInitial = (): OverlayTheme => {
	if (typeof window === "undefined") return DEFAULT_THEME;
	try {
		const saved = window.localStorage.getItem(STORAGE_KEY);
		return saved === "dark" || saved === "light" ? saved : DEFAULT_THEME;
	} catch {
		// localStorage can throw in private mode / sandboxed iframes — treat
		// as "no saved preference" and fall back to the default.
		return DEFAULT_THEME;
	}
};

export const ThemeProvider = ({ children }: { children: ReactNode }) => {
	const [theme, setThemeState] = useState<OverlayTheme>(readInitial);

	useEffect(() => {
		try {
			window.localStorage.setItem(STORAGE_KEY, theme);
		} catch {
			// best-effort; not having persistence isn't fatal
		}
	}, [theme]);

	const setTheme = useCallback((t: OverlayTheme) => setThemeState(t), []);
	const toggleTheme = useCallback(
		() => setThemeState((t) => (t === "light" ? "dark" : "light")),
		[],
	);

	return (
		<ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
			{children}
		</ThemeContext.Provider>
	);
};

export const useOverlayTheme = (): ThemeContextValue => {
	const ctx = useContext(ThemeContext);
	if (!ctx) {
		throw new Error("useOverlayTheme must be used within a ThemeProvider");
	}
	return ctx;
};

// Convenience helpers used by widgets. Each returns the className token to
// apply at the *root* of the overlay subtree — Tailwind's `.dark` variant
// (configured in index.css) cascades into descendants, so child elements
// can use `dark:bg-X` etc. without further opt-in.
export const overlayThemeClass = (theme: OverlayTheme): string =>
	theme === "dark" ? "dark" : "";
