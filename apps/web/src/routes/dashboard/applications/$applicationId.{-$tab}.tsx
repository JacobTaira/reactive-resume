import { createFileRoute, redirect } from "@tanstack/react-router";
import z from "zod";

export const Route = createFileRoute("/dashboard/applications/$applicationId/{-$tab}")({
	// Accept legacy workspace search fields so existing links remain compatible during the redirect.
	validateSearch: z.object({
		// true: the newest conversation about this job; "new": a fresh one; otherwise that conversation's id.
		coach: z
			.union([z.literal(true), z.string().min(1)])
			.optional()
			.catch(undefined),
		edit: z.literal("interview").optional().catch(undefined),
		version: z.string().min(1).optional().catch(undefined),
		// Practise opens with Speak selected ("Rehearse one answer aloud").
		speak: z.boolean().optional().catch(undefined),
		story: z.string().min(1).optional().catch(undefined),
	}),
	beforeLoad: ({ params }) => {
		throw redirect({
			to: "/dashboard/applications",
			search: { applicationId: params.applicationId, q: "", view: "list", closed: false, create: false },
			replace: true,
		});
	},
});
