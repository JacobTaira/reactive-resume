// @vitest-environment happy-dom

import type { QueueItem } from "@reactive-resume/api/dto/capture";
import type { QueueState } from "./queue-model";
import type { ReactNode } from "react";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	items: [] as QueueItem[],
	action: vi.fn(),
	toast: vi.fn(),
}));

vi.mock("@/libs/orpc/client", () => ({
	orpc: {
		applications: {
			key: () => ["applications"],
			queue: {
				key: () => ["applications", "queue"],
				list: {
					queryOptions: ({ input }: { input: { states: QueueState[] } }) => ({
						queryKey: ["applications", "queue", input],
						queryFn: async () => {
							const items = mocks.items.filter((item) => input.states.includes(item.preparation.state));
							const count = (state: QueueState) => mocks.items.filter((item) => item.preparation.state === state).length;
							return {
								items,
								total: items.length,
								nextOffset: null,
								counts: {
									pending: count("pending"),
									needs_details: count("needs_details"),
									processing: count("processing"),
									ready: count("ready"),
									failed: count("failed"),
									skipped: count("skipped"),
								},
							};
						},
					}),
				},
				action: { mutationOptions: () => ({ mutationFn: mocks.action }) },
			},
		},
	},
}));

vi.mock("@reactive-resume/ui/components/toast", () => ({ toast: { add: mocks.toast } }));
vi.mock("./queue-details-sheet", () => ({ QueueDetailsSheet: () => null }));
vi.mock("@tanstack/react-router", () => ({
	Link: ({ params, children }: { params: { resumeId: string }; children?: ReactNode }) => (
		<a href={`/builder/${params.resumeId}`}>{children}</a>
	),
}));

const { QueueView } = await import("./queue-view");

const job = (id: string, state: QueueState, draftResumeId: string | null = null): QueueItem => ({
	id,
	company: "Example company",
	role: `Engineer ${id}`,
	location: null,
	sourceUrl: "https://example.com/job/123",
	applicationStatus: "saved",
	capturedAt: "2026-10-19T00:00:00Z",
	createdAt: "2026-10-19T00:00:00Z",
	descriptionLength: state === "needs_details" ? 0 : 300,
	truncated: false,
	capture: null,
	preparation: {
		state,
		revision: 7,
		draftResumeId,
		notes: "",
		error: state === "failed" ? "Interrupted before PDF review" : "",
		leaseExpiresAt: null,
		updatedAt: "2026-10-19T00:00:00Z",
	},
	contentWarning: "Third-party page content",
});

beforeAll(() => i18n.loadAndActivate({ locale: "en", messages: {} }));
beforeEach(() => {
	vi.clearAllMocks();
	mocks.items = [];
	mocks.action.mockResolvedValue(undefined);
});
afterEach(cleanup);

function renderQueue() {
	return render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
			<I18nProvider i18n={i18n}>
				<QueueView query="" onOpen={vi.fn()} onAdd={vi.fn()} />
			</I18nProvider>
		</QueryClientProvider>,
	);
}

it("keeps incomplete captures and interrupted drafts visible", async () => {
	mocks.items = [job("missing", "needs_details"), job("interrupted", "failed", "existing-draft")];
	renderQueue();
	expect(await screen.findByRole("button", { name: "Engineer missing" })).toBeTruthy();
	expect(await screen.findByRole("button", { name: "Engineer interrupted" })).toBeTruthy();
	expect(screen.getByText("Interrupted before PDF review")).toBeTruthy();
	expect(screen.getByText("Open draft").closest("a")?.getAttribute("href")).toBe("/builder/existing-draft");
});

it("sends a revision-checked skip and keeps the job visible if saving fails", async () => {
	mocks.items = [job("missing", "needs_details")];
	mocks.action.mockRejectedValue(new Error("Queue revision changed"));
	renderQueue();
	const title = await screen.findByRole("button", { name: "Engineer missing" });
	const card = title.closest("article");
	if (!card) throw new Error("Missing saved-job card");
	fireEvent.click(within(card).getByRole("button", { name: "Skip" }));
	await waitFor(() => expect(mocks.action).toHaveBeenCalled());
	expect(mocks.action.mock.calls[0]?.[0]).toEqual({ id: "missing", expectedRevision: 7, action: "skip" });
	expect(screen.getByRole("button", { name: "Engineer missing" })).toBeTruthy();
	await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "error" })));
});

it("keeps ready resumes in an explicit review view", async () => {
	mocks.items = [job("ready", "ready", "tailored-resume")];
	renderQueue();
	fireEvent.click(await screen.findByRole("button", { name: /Ready for review.*1/ }));
	expect(await screen.findByText("Review resume")).toBeTruthy();
	expect(screen.getByText("Review resume").closest("a")?.getAttribute("href")).toBe("/builder/tailored-resume");
});
