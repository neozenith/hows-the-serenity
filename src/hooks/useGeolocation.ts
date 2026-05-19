import { useCallback, useState } from "react";

// Browser Geolocation API state machine. Single-shot via `getCurrentPosition`
// rather than `watchPosition` — the "Locate me" affordance is an on-demand
// pin-me-on-the-map action, not a live tracker, so we don't pay the battery
// cost of continuous watching.
//
// Discriminated union over the four PositionError codes plus the "no
// Geolocation in this environment" branch. Consumers narrow on `status` to
// access position fields or the error message.
export type GeolocationState =
	| { status: "idle" }
	| { status: "requesting" }
	| {
			status: "granted";
			longitude: number;
			latitude: number;
			accuracy: number;
			timestamp: number;
	  }
	| { status: "denied"; message: string }
	| { status: "unavailable"; message: string }
	| { status: "error"; message: string };

export type UseGeolocationResult = {
	state: GeolocationState;
	locate: () => void;
};

export const useGeolocation = (): UseGeolocationResult => {
	const [state, setState] = useState<GeolocationState>({ status: "idle" });

	const locate = useCallback(() => {
		if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
			setState({
				status: "unavailable",
				message: "Geolocation isn't available in this browser",
			});
			return;
		}
		setState({ status: "requesting" });
		navigator.geolocation.getCurrentPosition(
			(pos) => {
				setState({
					status: "granted",
					longitude: pos.coords.longitude,
					latitude: pos.coords.latitude,
					accuracy: pos.coords.accuracy,
					timestamp: pos.timestamp,
				});
			},
			(err) => {
				// PERMISSION_DENIED = 1, POSITION_UNAVAILABLE = 2, TIMEOUT = 3.
				// Map 1 to a dedicated "denied" branch so the UI can phrase the
				// recovery hint differently ("check site permissions") vs the
				// generic transient-failure path.
				if (err.code === err.PERMISSION_DENIED) {
					setState({ status: "denied", message: err.message });
					return;
				}
				setState({ status: "error", message: err.message });
			},
			{
				// High accuracy on — the dot is meaningless if it lands on the
				// wrong suburb. Costs more battery on mobile but the user
				// explicitly asked to be located.
				enableHighAccuracy: true,
				timeout: 15_000,
				// maximumAge: 0 forces a fresh fix every click rather than
				// reusing a cached one — matches the "show me my CURRENT
				// location" intent.
				maximumAge: 0,
			},
		);
	}, []);

	return { state, locate };
};
