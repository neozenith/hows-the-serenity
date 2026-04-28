import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@/lib/theme";
import "./index.css";
import App from "./App.tsx";

const rootElement = document.getElementById("root");
if (!rootElement) {
	throw new Error("Failed to find #root element in index.html");
}
createRoot(rootElement).render(
	<StrictMode>
		<ThemeProvider>
			<App />
		</ThemeProvider>
	</StrictMode>,
);
