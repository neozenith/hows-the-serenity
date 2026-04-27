/// <reference types="vite/client" />

// plotly.js-cartesian-dist-min is the ~700 KB cartesian-only Plotly bundle.
// It has no upstream type declarations, but its runtime API matches
// plotly.js (we have @types/plotly.js for the React factory's signatures).
// Tell TS the module exists; SuburbPlot.tsx hands it straight to
// react-plotly.js's createPlotlyComponent factory which is typed.
declare module "plotly.js-cartesian-dist-min";
