import { Component, type ErrorInfo, type ReactNode } from "react";

// Minimal class-component error boundary — there's no hooks-based equivalent
// in React 19. Wraps a subtree so a thrown render-time exception (or an
// uncaught error during a lazy chunk load) shows a tidy message instead of
// unmounting the whole App.

type Props = {
	fallback?: (err: Error) => ReactNode;
	children: ReactNode;
};

type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
	state: State = { error: null };

	static getDerivedStateFromError(error: Error): State {
		return { error };
	}

	componentDidCatch(error: Error, info: ErrorInfo): void {
		// Surface to console so DevTools shows the full stack — the panel
		// fallback only shows the message.
		console.error("ErrorBoundary caught:", error, info);
	}

	reset = (): void => this.setState({ error: null });

	render(): ReactNode {
		if (this.state.error) {
			if (this.props.fallback) return this.props.fallback(this.state.error);
			return (
				<div className="px-3 py-2 text-xs text-red-700">
					<strong>Render error:</strong> {this.state.error.message}
					<button
						type="button"
						onClick={this.reset}
						className="ml-2 cursor-pointer rounded border border-red-300 px-1.5 text-[10px]"
					>
						retry
					</button>
				</div>
			);
		}
		return this.props.children;
	}
}
