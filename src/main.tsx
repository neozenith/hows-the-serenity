import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { loadDataVersion } from "@/lib/data-version";
import { ThemeProvider } from "@/lib/theme";
import "./index.css";
import { Router } from "./router";

const rootElement = document.getElementById("root");
if (!rootElement) {
	throw new Error("Failed to find #root element in index.html");
}

// Block React mount on `version.json` so every consumer can call
// `versionedUrl(...)` synchronously without async-dance plumbing. The
// fetch is ~65 bytes and `cache: "no-cache"` — typically <50 ms over
// the wire. If it fails, loadDataVersion logs and falls back to v=0
// so the app still mounts.
loadDataVersion().then(() => {
	createRoot(rootElement).render(
		<StrictMode>
			<ThemeProvider>
				<Router />
			</ThemeProvider>
		</StrictMode>,
	);
});
