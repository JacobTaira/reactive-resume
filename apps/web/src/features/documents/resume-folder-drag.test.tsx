// @vitest-environment happy-dom

import type { DocumentSummary } from "./filter";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FolderMenu } from "./folder-menu";
import { FolderNavigation } from "./folder-navigation";
import { ResumeFolderDragProvider, useResumeFolderDrag } from "./resume-folder-drag";

type TestLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode; search: unknown; to: string };
type DragSourceProps = { document: DocumentSummary };

const { saveMetadata, listFolders, createFolder, notify } = vi.hoisted(() => ({
	saveMetadata: vi.fn(),
	listFolders: vi.fn(),
	createFolder: vi.fn(),
	notify: vi.fn(),
}));

vi.mock("@/libs/orpc/client", () => ({
	orpc: {
		library: {
			key: () => ["library"],
			folders: {
				list: { queryOptions: () => ({ queryKey: ["library", "folders"], queryFn: listFolders }) },
				create: { mutationOptions: () => ({ mutationFn: createFolder }) },
				update: { mutationOptions: () => ({ mutationFn: vi.fn() }) },
				delete: { mutationOptions: () => ({ mutationFn: vi.fn() }) },
			},
			resumes: { setMetadata: { mutationOptions: () => ({ mutationFn: saveMetadata }) } },
		},
		documents: { key: () => ["documents"] },
		resume: { key: () => ["resume"] },
	},
}));
vi.mock("@tanstack/react-router", () => ({
	Link: ({ children, search: _search, to: _to, ...props }: TestLinkProps) => <a href="/dashboard" {...props}>{children}</a>,
	useSearch: () => ({}),
	useMatchRoute: () => () => false,
}));
vi.mock("@reactive-resume/ui/components/toast", () => ({ toast: { add: notify } }));
vi.mock("@/hooks/use-confirm", () => ({ useConfirm: () => vi.fn() }));
vi.mock("./resume-drag-preview", () => ({ setResumeDragPreview: vi.fn() }));

beforeEach(() => {
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	saveMetadata.mockReset().mockResolvedValue({});
	createFolder.mockReset();
	notify.mockReset();
	listFolders.mockReset().mockResolvedValue([
		{ id: "parent", name: "Jobs", parentId: null },
		{ id: "child", name: "Robotics", parentId: "parent" },
	]);
});

function DragSource({ document }: DragSourceProps) {
	const dragProps = useResumeFolderDrag(document);
	return <article aria-label="Test resume" {...dragProps}>Example resume</article>;
}

function setup(overrides: Partial<DocumentSummary> = {}, children?: ReactNode) {
	const document = { id: "resume-1", type: "resume", name: "Example", folderId: null, trashedAt: null, ...overrides } as DocumentSummary;
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const invalidate = vi.spyOn(queryClient, "invalidateQueries");
	const view = render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={queryClient}>
				<ResumeFolderDragProvider>
					<DragSource document={document} />
					<div data-testid="folder-menu"><FolderMenu /></div>
					{children}
				</ResumeFolderDragProvider>
			</QueryClientProvider>
		</I18nProvider>,
	);
	return { queryClient, invalidate, view, source: screen.getByLabelText("Test resume") };
}

it("shows a newly created folder in navigation before its background refresh completes", async () => {
	const onChange = vi.fn();
	const { queryClient } = setup({}, <FolderNavigation folderId={undefined} onChange={onChange} onNewResume={vi.fn()} />);
	await within(screen.getByTestId("folder-menu")).findByRole("link", { name: "Jobs" });
	createFolder.mockResolvedValue({ id: "new", name: "Summer roles", parentId: null });
	listFolders.mockImplementation(() => new Promise(() => undefined));
	fireEvent.click(screen.getByRole("button", { name: "New folder" }));
	fireEvent.change(await screen.findByLabelText("Folder name"), { target: { value: "Summer roles" } });
	fireEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
	expect(await within(screen.getByTestId("folder-menu")).findByRole("link", { name: "Summer roles" })).toBeVisible();
	expect(createFolder).toHaveBeenCalledWith({ name: "Summer roles", parentId: null });
	expect(onChange).toHaveBeenCalledWith("new");
	queryClient.clear();
});

function transfer() {
	const values = new Map<string, string>();
	return {
		get types() { return [...values.keys()]; },
		getData: (type: string) => values.get(type) ?? "",
		setData: (type: string, value: string) => values.set(type, value),
		clearData: () => values.clear(),
		setDragImage: vi.fn(),
		effectAllowed: "none",
		dropEffect: "none",
	};
}

it("moves a locked resume to a visible nested folder with only a folder patch and confirmed cache refresh", async () => {
	const { source, invalidate } = setup({ isLocked: true });
	const target = await screen.findByRole("link", { name: "Jobs / Robotics" });
	const dataTransfer = transfer();
	fireEvent.dragStart(source, { dataTransfer });
	fireEvent.dragOver(target, { dataTransfer });
	expect(target).toHaveClass("bg-accent-soft");
	fireEvent.drop(target, { dataTransfer });
	await waitFor(() => expect(saveMetadata).toHaveBeenCalledExactlyOnceWith({ resumeId: "resume-1", folderId: "child" }));
	await waitFor(() => expect(notify).toHaveBeenCalledWith({ description: "Resume moved" }));
	expect(invalidate).toHaveBeenCalledWith({ queryKey: ["documents"] });
	expect(invalidate).toHaveBeenCalledWith({ queryKey: ["library"] });
});

it("moves a filed resume back to Unfiled resumes", async () => {
	const { source } = setup({ folderId: "child" });
	const target = await screen.findByRole("link", { name: "Unfiled resumes" });
	const dataTransfer = transfer();
	fireEvent.dragStart(source, { dataTransfer });
	fireEvent.drop(target, { dataTransfer });
	await waitFor(() => expect(saveMetadata).toHaveBeenCalledExactlyOnceWith({ resumeId: "resume-1", folderId: null }));
});

it("does not keep a canceled drag's highlight when another drag starts", async () => {
	const { source } = setup();
	const target = await screen.findByRole("link", { name: "Jobs" });
	const dataTransfer = transfer();
	fireEvent.dragStart(source, { dataTransfer });
	fireEvent.dragOver(target, { dataTransfer });
	expect(target).toHaveClass("bg-accent-soft");
	fireEvent.dragEnd(source, { dataTransfer });
	fireEvent.dragStart(source, { dataTransfer });
	expect(target).not.toHaveClass("bg-accent-soft");
	expect(saveMetadata).not.toHaveBeenCalled();
});

it("ignores external payloads and drops into the resume's existing folder", async () => {
	const { source } = setup({ folderId: "child" });
	const target = await screen.findByRole("link", { name: "Jobs / Robotics" });
	const dataTransfer = transfer();
	dataTransfer.setData("application/x-reactive-resume-id", "resume-1");
	expect(fireEvent.drop(target, { dataTransfer })).toBe(true);
	fireEvent.dragStart(source, { dataTransfer });
	fireEvent.drop(target, { dataTransfer });
	expect(saveMetadata).not.toHaveBeenCalled();
});

it("reports a failed save without claiming success or invalidating saved state", async () => {
	saveMetadata.mockRejectedValue(new Error("Unavailable"));
	const { source, invalidate } = setup();
	const target = await screen.findByRole("link", { name: "Jobs" });
	const dataTransfer = transfer();
	fireEvent.dragStart(source, { dataTransfer });
	fireEvent.drop(target, { dataTransfer });
	await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: "error" })));
	expect(invalidate).not.toHaveBeenCalled();
	expect(notify).not.toHaveBeenCalledWith({ description: "Resume moved" });
});

it.each([{ type: "letter" as const }, { trashedAt: new Date() }])("does not drag letters or trashed resumes: %j", (overrides) => {
	const { source } = setup(overrides);
	expect(source).toHaveAttribute("draggable", "false");
	const dataTransfer = transfer();
	fireEvent.dragStart(source, { dataTransfer });
	expect(dataTransfer.types).toEqual([]);
});
