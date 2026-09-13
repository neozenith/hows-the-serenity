// MapLibre 6 locates its web worker at runtime with
// `new URL("./maplibre-gl-worker.mjs", import.meta.url)`. The file name is
// computed from a variable, so Vite cannot see it: the build never emits the
// worker, and the dev optimizer rebundles the entry away from its sibling.
// Either way the basemap loads no tiles. Importing the worker with
// `?worker&url` makes Vite bundle it as a real worker chunk; handing that URL
// to MapLibre replaces the guess. Import this module for its side effect
// before any <Map> mounts.
import { setWorkerUrl } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

setWorkerUrl(workerUrl);
