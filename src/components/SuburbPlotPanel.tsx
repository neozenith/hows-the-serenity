import { lazy, Suspense } from "react";

// Lazy import — Plotly + the rental-sales query module land in their own
// chunk that only downloads when the user first clicks a suburb. Without
// this the eager bundle gains ~700 KB.
const SuburbPlot = lazy(() => import("./SuburbPlot"));

export const SuburbPlotPanel = ({
	suburb,
	onClose,
}: {
	suburb: string | null;
	onClose: () => void;
}) => {
	if (!suburb) return null;
	return (
		<aside className="-translate-x-1/2 absolute bottom-4 left-1/2 z-10 w-[min(900px,calc(100vw-32px))] rounded-md bg-white/95 px-3 py-2 text-sm shadow-md backdrop-blur">
			<header className="mb-1 flex items-center justify-between gap-2">
				<h2 className="font-semibold text-neutral-900">{suburb}</h2>
				<button
					type="button"
					onClick={onClose}
					aria-label="Close suburb plot"
					className="cursor-pointer rounded px-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
				>
					<span aria-hidden="true">×</span>
				</button>
			</header>
			<Suspense
				fallback={
					<div className="px-2 py-8 text-xs text-neutral-500">
						Loading chart…
					</div>
				}
			>
				<SuburbPlot suburb={suburb} />
			</Suspense>
		</aside>
	);
};
