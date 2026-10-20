import { createFileRoute, redirect } from "@tanstack/react-router";

// Career is removed from this fork's interface. Existing bookmarks land on the application tracker.
export const Route = createFileRoute("/dashboard/career")({
	beforeLoad: () => {
		throw redirect({ to: "/dashboard/applications", replace: true });
	},
});
