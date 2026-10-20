// @vitest-environment happy-dom
import type { Application } from "../types";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const api = vi.hoisted(() => ({
	hasProvider: true,
	bulkDelete: vi.fn(),
	bulkUpdate: vi.fn(),
	parsePosting: vi.fn(),
	create: vi.fn(),
	moveTo: vi.fn(),
	close: vi.fn(),
	remove: vi.fn(),
	invalidate: vi.fn(),
	confirm: vi.fn(),
}));
vi.mock("@/libs/orpc/client", () => ({
	client: { applications: { ai: { parsePosting: api.parsePosting } } },
	orpc: {
		applications: {
			bulkDelete: { mutationOptions: () => ({ mutationFn: api.bulkDelete }) },
			bulkUpdate: { mutationOptions: () => ({ mutationFn: api.bulkUpdate }) },
			create: { mutationOptions: () => ({ mutationFn: api.create }) },
			ai: {
				parsePosting: { mutationOptions: () => ({ mutationFn: api.parsePosting }) },
				searchPostings: { mutationOptions: () => ({ mutationFn: async () => [] }) },
			},
		},
		webAccess: {
			status: { queryOptions: () => ({ queryKey: ["web-access"], queryFn: async () => ({ search: false }) }) },
		},
		documents: { list: { queryOptions: () => ({ queryKey: ["documents"], queryFn: async () => [] }) } },
	},
}));
vi.mock("../use-application-actions", () => ({
	useInvalidateApplications: () => api.invalidate,
	useApplicationActions: () => ({ moveTo: api.moveTo, close: api.close, remove: { mutate: api.remove } }),
}));
vi.mock("@/hooks/use-confirm", () => ({ useConfirm: () => api.confirm }));
vi.mock("@reactive-resume/ui/hooks/use-breakpoint", () => ({ useBreakpoint: () => "desktop" }));
vi.mock("@/features/settings/integrations/hooks/use-has-usable-ai-provider", () => ({
	useHasUsableAiProvider: () => ({ hasUsableProvider: api.hasProvider }),
}));
vi.mock("@/dialogs/store", () => ({ useDialogStore: () => vi.fn() }));
vi.mock("@reactive-resume/ui/components/toast", () => ({ toast: { add: vi.fn() } }));

import { AddApplicationDialog } from "./add-application-dialog";
import { ApplicationBoard } from "./board";
import { ApplicationList } from "./list-view";

const application = (id: string, status: Application["status"]): Application => ({
	id,
	company: id === "closed" ? "Closed Co" : "Open Co",
	role: "Engineer",
	status,
	closedReason: status === "closed" ? "not-selected" : null,
	coverLetterId: null,
	sentResumeVersionId: null,
	sentCoverLetterVersionId: null,
	sentCheckScore: null,
	requirements: [],
	location: null,
	salary: null,
	source: null,
	sourceUrl: null,
	notes: null,
	tags: [],
	contacts: [],
	activity: [],
	appliedAt: new Date(),
	createdAt: new Date(),
	updatedAt: new Date(),
	resumeId: null,
	jobDescription: null,
	postingSource: null,
	matchScore: null,
	aiMetadata: null,
	resumeFileUrl: null,
	resumeFileName: null,
	coverLetterUrl: null,
	coverLetterName: null,
	followUpAt: null,
	followUpNote: null,
});
const clients: QueryClient[] = [];
const mount = (children: ReactNode) => {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
	clients.push(client);
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>
			<I18nProvider i18n={i18n}>{children}</I18nProvider>
		</QueryClientProvider>
	);
	return render(children, { wrapper });
};
beforeEach(() => {
	vi.clearAllMocks();
	api.hasProvider = true;
	api.parsePosting.mockReset();
	api.create.mockReset().mockResolvedValue("saved-job");
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	api.confirm.mockResolvedValue(true);
	api.bulkDelete.mockResolvedValue({ deleted: 1 });
});

afterEach(() => {
	cleanup();
	clients.splice(0).forEach((client) => client.clear());
});

it("saves pasted job text without reading a webpage or configuring an AI provider", async () => {
	api.hasProvider = false;
	const onAdded = vi.fn();
	mount(<AddApplicationDialog open onOpenChange={vi.fn()} onAdded={onAdded} />);
	const posting = "Robotics Engineer at Example Company. Build navigation and controls systems.";
	fireEvent.change(await screen.findByRole("textbox", { name: "Job link or posting text" }), { target: { value: posting } });
	fireEvent.change(screen.getByRole("textbox", { name: "Role" }), { target: { value: "Robotics Engineer" } });
	fireEvent.change(screen.getByRole("textbox", { name: "Company" }), { target: { value: "Example Company" } });
	fireEvent.click(screen.getByRole("button", { name: "Save job" }));
	await waitFor(() => expect(onAdded).toHaveBeenCalledWith("saved-job"));
	expect(api.create.mock.calls[0]?.[0]).toMatchObject({ company: "Example Company", role: "Robotics Engineer", status: "saved", jobDescription: posting });
	expect(api.parsePosting).not.toHaveBeenCalled();
});

it("can save the original posting URL after its webpage cannot be read", async () => {
	api.hasProvider = false;
	api.parsePosting.mockRejectedValue(new Error("Page unavailable"));
	const onAdded = vi.fn();
	mount(<AddApplicationDialog open onOpenChange={vi.fn()} onAdded={onAdded} />);
	fireEvent.change(await screen.findByRole("textbox", { name: "Job link or posting text" }), { target: { value: "https://example.test/job" } });
	fireEvent.click(screen.getByRole("button", { name: "Read posting" }));
	await screen.findByRole("textbox", { name: "Pasted description" });
	fireEvent.change(screen.getByRole("textbox", { name: "Role" }), { target: { value: "Engineer" } });
	fireEvent.change(screen.getByRole("textbox", { name: "Company" }), { target: { value: "Example" } });
	fireEvent.click(screen.getByRole("button", { name: "Save job" }));
	await waitFor(() => expect(onAdded).toHaveBeenCalledWith("saved-job"));
	expect(api.create.mock.calls[0]?.[0]).toMatchObject({ company: "Example", role: "Engineer", status: "saved", sourceUrl: "https://example.test/job" });
});

it("retains the entered job and leaves the form open when saving fails", async () => {
	api.hasProvider = false;
	api.create.mockRejectedValue(new Error("Database unavailable"));
	const onOpenChange = vi.fn();
	const onAdded = vi.fn();
	mount(<AddApplicationDialog open onOpenChange={onOpenChange} onAdded={onAdded} />);
	fireEvent.change(await screen.findByRole("textbox", { name: "Job link or posting text" }), { target: { value: "Original job description" } });
	fireEvent.change(screen.getByRole("textbox", { name: "Role" }), { target: { value: "Engineer" } });
	fireEvent.change(screen.getByRole("textbox", { name: "Company" }), { target: { value: "Example" } });
	fireEvent.click(screen.getByRole("button", { name: "Save job" }));
	await waitFor(() => expect(api.create).toHaveBeenCalled());
	await waitFor(() => expect((screen.getByRole("button", { name: "Save job" }) as HTMLButtonElement).disabled).toBe(false));
	expect((screen.getByRole("textbox", { name: "Job link or posting text" }) as HTMLTextAreaElement).value).toBe("Original job description");
	expect(onOpenChange).not.toHaveBeenCalled();
	expect(onAdded).not.toHaveBeenCalled();
});

it("removes hidden closed applications from bulk selection before deleting visible rows", async () => {
	const rows = [application("open", "saved"), application("closed", "closed")];
	const view = mount(<ApplicationList applications={rows} showClosed selectedId={null} onOpen={vi.fn()} />);
	fireEvent.click(screen.getByRole("checkbox", { name: "Select Engineer at Open Co" }));
	fireEvent.click(screen.getByRole("checkbox", { name: "Select Engineer at Closed Co" }));
	expect(screen.getByText("2 selected")).toBeTruthy();
	view.rerender(<ApplicationList applications={rows} showClosed={false} selectedId={null} onOpen={vi.fn()} />);
	expect(screen.queryByRole("checkbox", { name: "Select Engineer at Closed Co" })).toBeNull();
	expect(screen.getByText("1 selected")).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "Delete…" }));
	await waitFor(() => expect(api.bulkDelete.mock.calls[0]?.[0]).toEqual({ ids: ["open"] }));
});

it("offers one board-card open control and a separate options control without a dead draggable tab stop", async () => {
	const row = application("open", "saved");
	const onOpen = vi.fn();
	const view = mount(<ApplicationBoard applications={[row]} showClosed={false} onOpen={onOpen} />);
	const open = screen.getByRole("button", { name: "Engineer Open Co" });
	const options = screen.getByRole("button", { name: "Options for Engineer at Open Co" });
	expect(view.container.querySelector("button button, [role=button] button")).toBeNull();
	for (let parent = open.parentElement; parent && parent !== view.container; parent = parent.parentElement) {
		expect(parent.tabIndex).toBeLessThan(0);
	}
	fireEvent.click(open);
	expect(onOpen).toHaveBeenCalledExactlyOnceWith(row);
	fireEvent.click(options);
	await screen.findByRole("menu");
	expect(onOpen).toHaveBeenCalledTimes(1);
});

it.each(["ai", "page"])(
	"does not report successful %s extraction when role and company are blank",
	async (filledBy) => {
		api.parsePosting.mockResolvedValue({
			role: "",
			company: "",
			location: "",
			salary: "",
			requirements: [],
			jobDescription: "A general careers landing page",
			filledBy,
			postingSource: { method: "fetch", format: "text", truncated: false, completeness: "unknown" },
		});
		mount(<AddApplicationDialog open onOpenChange={vi.fn()} onAdded={vi.fn()} />);
		fireEvent.change(await screen.findByRole("textbox", { name: "Job link or posting text" }), {
			target: { value: "https://example.test/careers" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Read posting" }));
		await screen.findByText(/Some job details couldn't be read/);
		expect(screen.queryByText(/Found (the )?role,? (and )?company/)).toBeNull();
		expect((screen.getByRole("button", { name: "Save job" }) as HTMLButtonElement).disabled).toBe(true);
		expect((screen.getByRole("textbox", { name: "Saved description" }) as HTMLTextAreaElement).value).toBe(
			"A general careers landing page",
		);
		fireEvent.change(screen.getByRole("textbox", { name: "Role" }), { target: { value: "Engineer" } });
		fireEvent.change(screen.getByRole("textbox", { name: "Company" }), { target: { value: "Known Company" } });
		expect((screen.getByRole("button", { name: "Save job" }) as HTMLButtonElement).disabled).toBe(false);
	},
);

