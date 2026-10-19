// oxlint-disable typescript/no-non-null-assertion -- These tests assert registered tool names before exercising handlers.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ORPCError } from "@orpc/server";
import { TOOL_META } from "./tool-meta";

vi.mock("@reactive-resume/api/context", () => ({
	resolveUserFromRequestHeaders: vi.fn(),
}));

vi.mock("./files", () => ({ readMcpFile: vi.fn() }));

vi.mock("@reactive-resume/api/features/resume/export", () => ({
	createResumePdfDownloadUrl: vi.fn(),
}));

vi.mock("@reactive-resume/env/server", () => ({
	env: {
		APP_URL: "https://example.com",
	},
}));

const { MCP_TOOL_NAME } = await import("./mcp-tool-names");
const { registerTools } = await import("./tools");

type ToolHandler = (input: Record<string, unknown>) => Promise<{
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
	structuredContent?: Record<string, unknown>;
}>;

type Registration = {
	name: string;
	config: {
		title?: string;
		description?: string;
		inputSchema?: unknown;
	};
	handler: ToolHandler;
};

const makeFakeServer = () => {
	const registered: Registration[] = [];
	const server = {
		registerTool: vi.fn((name: string, config: Registration["config"], handler: ToolHandler) => {
			registered.push({ name, config, handler });
		}),
	};
	return { server, registered };
};

const clientMock = {
	library: {
		folders: { list: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
		companies: { list: vi.fn(), getById: vi.fn(), save: vi.fn(), delete: vi.fn() },
		resumes: { getMetadata: vi.fn(), setMetadata: vi.fn(), index: vi.fn(), compare: vi.fn() },
		jobs: { index: vi.fn() },
	},
	resume: {
		latex: { compile: vi.fn() },
		getById: vi.fn(),
		list: vi.fn(),
		tags: { list: vi.fn() },
		create: vi.fn(),
		import: vi.fn(),
		duplicate: vi.fn(),
		patch: vi.fn(),
		update: vi.fn(),
		delete: vi.fn(),
		setLocked: vi.fn(),
		statistics: { getById: vi.fn() },
	},
	coverLetters: {
		list: vi.fn(),
		getById: vi.fn(),
		create: vi.fn(),
		update: vi.fn(),
		refreshStyle: vi.fn(),
		duplicate: vi.fn(),
		delete: vi.fn(),
		copyEmbedded: vi.fn(),
		export: vi.fn(),
		import: vi.fn(),
	},
	applications: {
		queue: { list: vi.fn(), read: vi.fn(), claim: vi.fn(), update: vi.fn(), finish: vi.fn(), action: vi.fn() },
		list: vi.fn(),
		getById: vi.fn(),
		tags: vi.fn(),
		stats: vi.fn(),
		create: vi.fn(),
		update: vi.fn(),
		addNote: vi.fn(),
		addInterview: vi.fn(),
		updateInterview: vi.fn(),
		updateTimelineEntry: vi.fn(),
		deleteTimelineEntry: vi.fn(),
		delete: vi.fn(),
		bulkUpdate: vi.fn(),
		bulkDelete: vi.fn(),
		import: vi.fn(),
		attachDocument: vi.fn(),
		removeDocument: vi.fn(),
		ai: {
			autofill: vi.fn(),
			matchScore: vi.fn(),
			tailorResume: vi.fn(),
			draftMessage: vi.fn(),
		},
	},
};

describe("registerTools", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("registers every queue tool, lists compact records and reads full source separately", async () => {
		const { server, registered } = makeFakeServer();
		registerTools(server as never, clientMock as never, new Headers());
		for (const name of [
			MCP_TOOL_NAME.listTailoringQueue, MCP_TOOL_NAME.readTailoringQueueJob, MCP_TOOL_NAME.claimQueueJob,
			MCP_TOOL_NAME.updateQueueJob, MCP_TOOL_NAME.finishQueueJob, MCP_TOOL_NAME.skipQueueJob, MCP_TOOL_NAME.requeueJob,
		]) expect(registered.filter((item) => item.name === name)).toHaveLength(1);
		clientMock.applications.queue.list.mockResolvedValueOnce({ items: [{ id: "app" }], total: 1, nextOffset: null });
		await registered.find((item) => item.name === MCP_TOOL_NAME.listTailoringQueue)!.handler({});
		expect(clientMock.applications.queue.list).toHaveBeenCalledWith({ limit: 30, offset: 0, includeDescription: false });
		clientMock.applications.queue.read.mockResolvedValueOnce({ id: "app", description: "Captured evidence" });
		await registered.find((item) => item.name === MCP_TOOL_NAME.readTailoringQueueJob)!.handler({ id: "app" });
		expect(clientMock.applications.queue.read).toHaveBeenCalledWith({ id: "app", includeDescription: true });
		expect(clientMock.applications.ai.autofill).not.toHaveBeenCalled();
		expect(clientMock.applications.ai.tailorResume).not.toHaveBeenCalled();
	});

	it("forwards current lease/revision snapshots and leaves finish validation to the shared API", async () => {
		const { server, registered } = makeFakeServer();
		registerTools(server as never, clientMock as never, new Headers());
		const leaseToken = "private-workflow-token-123";
		clientMock.applications.queue.claim.mockResolvedValueOnce({ item: { id: "app", preparation: { revision: 2 } }, leaseToken });
		await registered.find((item) => item.name === MCP_TOOL_NAME.claimQueueJob)!.handler({ id: "app", expectedRevision: 1 });
		expect(clientMock.applications.queue.claim).toHaveBeenCalledWith({ id: "app", expectedRevision: 1, leaseSeconds: 900 });
		const input = { id: "app", expectedRevision: 2, leaseToken, outcome: "ready", draftResumeId: "draft", expectedResumeUpdatedAt: "2026-10-19T03:00:00Z" };
		clientMock.applications.queue.finish.mockResolvedValueOnce({ id: "app", preparation: { state: "ready", revision: 3 } });
		await registered.find((item) => item.name === MCP_TOOL_NAME.finishQueueJob)!.handler(input);
		expect(clientMock.applications.queue.finish).toHaveBeenCalledWith(input);
		expect(clientMock.applications.update).not.toHaveBeenCalled();
	});

	it("uses explicit skip/requeue actions and reports claim conflicts without preparing a duplicate", async () => {
		const { server, registered } = makeFakeServer();
		registerTools(server as never, clientMock as never, new Headers());
		await registered.find((item) => item.name === MCP_TOOL_NAME.skipQueueJob)!.handler({ id: "app", expectedRevision: 4 });
		await registered.find((item) => item.name === MCP_TOOL_NAME.requeueJob)!.handler({ id: "app", expectedRevision: 5 });
		expect(clientMock.applications.queue.action).toHaveBeenNthCalledWith(1, { id: "app", expectedRevision: 4, action: "skip" });
		expect(clientMock.applications.queue.action).toHaveBeenNthCalledWith(2, { id: "app", expectedRevision: 5, action: "requeue" });
		clientMock.applications.queue.claim.mockRejectedValueOnce(new ORPCError("CONFLICT", { message: "Already processing." }));
		const result = await registered.find((item) => item.name === MCP_TOOL_NAME.claimQueueJob)!.handler({ id: "app", expectedRevision: 1 });
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("Already processing");
		expect(clientMock.resume.duplicate).not.toHaveBeenCalled();
	});

	it("compiles LaTeX using document tools without returning PDF bytes to the model", async () => {
		const { server, registered } = makeFakeServer();
		registerTools(server as never, clientMock as never, new Headers());
		clientMock.resume.latex.compile.mockResolvedValueOnce({ success: true, pdf: "private-pdf-bytes", log: "done" });
		const tool = registered.find((item) => item.name === MCP_TOOL_NAME.compileResumeLatex)!;
		const result = await tool.handler({ id: "r1" });
		expect(clientMock.resume.latex.compile).toHaveBeenCalledWith({ id: "r1" });
		expect(result.structuredContent).toMatchObject({ success: true, log: "done", checks: null });
		expect(result.structuredContent?.diagnosticsNote).toContain("remain unverified");
		expect(JSON.stringify(result)).not.toContain("private-pdf-bytes");
		expect(clientMock.resume.update).not.toHaveBeenCalled();
	});

	it("returns bounded compiler checks and forwards the user's expected page count", async () => {
		const { server, registered } = makeFakeServer();
		registerTools(server as never, clientMock as never, new Headers());
		const checks = {
			pageCount: 2,
			expectedPageCount: 1,
			pageCountMatches: false,
			pageCountError: null,
			overfullBoxes: { count: 1, messages: ["Overfull \\hbox"], truncated: false },
			textExtraction: {
				status: "success",
				characterCount: 19,
				text: "Verified resume text",
				preview: "Verified resume text",
				truncated: false,
				error: null,
			},
		};
		clientMock.resume.latex.compile.mockResolvedValueOnce({ success: true, pdf: "private-pdf-bytes", log: "done", checks });
		const tool = registered.find((item) => item.name === MCP_TOOL_NAME.compileResumeLatex)!;
		const result = await tool.handler({ id: "r1", expectedPageCount: 1 });
		expect(clientMock.resume.latex.compile).toHaveBeenCalledWith({ id: "r1", expectedPageCount: 1 });
		expect(result.structuredContent).toEqual({ success: true, log: "done", checks, diagnosticsNote: null });
		expect(TOOL_META[MCP_TOOL_NAME.compileResumeLatex].outputSchema.safeParse(result.structuredContent).success).toBe(true);
		expect(JSON.stringify(result)).not.toContain("private-pdf-bytes");
		expect(TOOL_META[MCP_TOOL_NAME.compileResumeLatex].inputSchema.safeParse({ id: "r1", expectedPageCount: 0 }).success).toBe(false);
	});

	it("does not invent diagnostic passes when a previous worker omits checks", async () => {
		const { server, registered } = makeFakeServer();
		registerTools(server as never, clientMock as never, new Headers());
		clientMock.resume.latex.compile.mockResolvedValueOnce({ success: false, log: "Compile failed" });
		const result = await registered.find((item) => item.name === MCP_TOOL_NAME.compileResumeLatex)!.handler({ id: "r1" });
		expect(result.structuredContent).toMatchObject({ success: false, log: "Compile failed", checks: null });
		expect(result.structuredContent?.diagnosticsNote).toContain("unavailable");
	});

	it("reads the saved master's LaTeX source without filtering it by folder", async () => {
		const { server, registered } = makeFakeServer();
		registerTools(server as never, clientMock as never, new Headers());
		const data = {
			latex: { engine: "pdflatex", entrypoint: "main.tex", files: [{ path: "main.tex", content: "Master evidence" }] },
		};
		clientMock.resume.getById.mockResolvedValueOnce({ id: "master", data });
		const result = await registered.find((tool) => tool.name === MCP_TOOL_NAME.getResume)!.handler({ id: "master" });
		expect(JSON.parse(result.content[0]!.text)).toEqual(data);
		expect(clientMock.resume.getById).toHaveBeenCalledWith({ id: "master" });
		expect(clientMock.library.resumes.index).not.toHaveBeenCalled();
	});

	it("uses compact library discovery and requires full reads separately", async () => {
		const { server, registered } = makeFakeServer();
		registerTools(server as never, clientMock as never, new Headers());
		const index = [{ id: "related", company: "Example", similarity: 70, reuseHints: ["Shared role terms"] }];
		clientMock.library.resumes.index.mockResolvedValueOnce(index);
		const tool = registered.find((item) => item.name === MCP_TOOL_NAME.findRelatedResumes)!;
		const result = await tool.handler({ company: "Example", keywords: ["robotics"], limit: 10 });
		expect(clientMock.library.resumes.index).toHaveBeenCalledWith({ company: "Example", keywords: ["robotics"], limit: 10 });
		expect(result.structuredContent).toEqual({ items: index });
		expect(clientMock.resume.getById).not.toHaveBeenCalled();
	});

	it("moves a resume without overwriting its profile or content", async () => {
		const { server, registered } = makeFakeServer();
		registerTools(server as never, clientMock as never, new Headers());
		clientMock.library.resumes.setMetadata.mockResolvedValueOnce({ resumeId: "resume-1", folderId: "folder-1" });
		const tool = registered.find((item) => item.name === MCP_TOOL_NAME.moveResume)!;
		await tool.handler({ resumeId: "resume-1", folderId: "folder-1" });
		expect(clientMock.library.resumes.setMetadata).toHaveBeenCalledWith({ resumeId: "resume-1", folderId: "folder-1" });
		expect(clientMock.resume.patch).not.toHaveBeenCalled();
		expect(clientMock.resume.update).not.toHaveBeenCalled();
		expect(TOOL_META[MCP_TOOL_NAME.moveResume].inputSchema.safeParse({ resumeId: "resume-1" }).success).toBe(false);
	});

	it("persists evidence, change rationale and a reported outcome without altering resume content or application stage", async () => {
		const { server, registered } = makeFakeServer();
		registerTools(server as never, clientMock as never, new Headers());
		const profile = {
			requirementEvidence: [{
				requirement: "Robotics experience", importance: "required", status: "supported",
				evidence: [{ resumeId: "master", locator: "main.tex:42", quote: "Built a robot controller" }], notes: "Source quote supports this claim.",
			}],
			tailoringChanges: [{ section: "Experience", before: "Built a controller", after: "Built a robot controller", reason: "Clarify relevant domain." }],
			reviewedResumeUpdatedAt: "2026-10-19T12:00:00.000Z",
			reviewedSourceUpdatedAt: "2026-10-19T10:00:00.000Z",
			outcome: { stage: "interview", notes: "User reported an interview invitation.", recordedAt: "2026-10-19T12:30:00.000Z" },
		};
		clientMock.library.resumes.setMetadata.mockResolvedValueOnce({ resumeId: "r1", profile });
		const result = await registered.find((item) => item.name === MCP_TOOL_NAME.updateResumeMetadata)!.handler({ resumeId: "r1", profile });
		expect(clientMock.library.resumes.setMetadata).toHaveBeenCalledWith({ resumeId: "r1", profile });
		expect(result.structuredContent?.profile).toEqual(profile);
		expect(clientMock.resume.patch).not.toHaveBeenCalled();
		expect(clientMock.applications.update).not.toHaveBeenCalled();
	});

	it("passes explicit historical source selection to an actual comparison and preserves truncation flags", async () => {
		const { server, registered } = makeFakeServer();
		registerTools(server as never, clientMock as never, new Headers());
		const comparison = {
			target: { id: "draft", name: "Draft", updatedAt: "2026-10-19T12:00:00.000Z", versionId: null },
			source: { id: "base", name: "Base", updatedAt: "2026-10-18T12:00:00.000Z", versionId: "historical" },
			comparison: "latex", identical: false, truncated: true,
			files: [{ path: "main.tex", kind: "modified", binary: false, addedLines: 1, removedLines: 1, coarse: true, truncated: true, lines: [] }],
		};
		clientMock.library.resumes.compare.mockResolvedValueOnce(comparison);
		const result = await registered.find((item) => item.name === MCP_TOOL_NAME.compareResumes)!.handler({ resumeId: "draft", sourceResumeId: "base", sourceVersionId: "historical" });
		expect(clientMock.library.resumes.compare).toHaveBeenCalledWith({ resumeId: "draft", sourceResumeId: "base", sourceVersionId: "historical" });
		expect(result.structuredContent).toEqual(comparison);
		expect(TOOL_META[MCP_TOOL_NAME.compareResumes].outputSchema.safeParse(result.structuredContent).success).toBe(true);
		expect(clientMock.resume.patch).not.toHaveBeenCalled();
	});

	it("finds related saved jobs even when they have no linked resume", async () => {
		const { server, registered } = makeFakeServer();
		registerTools(server as never, clientMock as never, new Headers());
		const jobs = [{ id: "job-1", company: "Example", role: "Robotics Engineer", resumeId: null, similarity: 70 }];
		clientMock.library.jobs.index.mockResolvedValueOnce(jobs);
		const tool = registered.find((item) => item.name === MCP_TOOL_NAME.findRelatedJobs)!;
		const result = await tool.handler({ company: "Example", keywords: ["robotics"] });
		expect(clientMock.library.jobs.index).toHaveBeenCalledWith({ company: "Example", keywords: ["robotics"], limit: 30 });
		expect(result.structuredContent).toEqual({ items: jobs });
		expect(clientMock.applications.getById).not.toHaveBeenCalled();
	});

	it("requires a company revision and surfaces stale research updates for rereading", async () => {
		const { server, registered } = makeFakeServer();
		registerTools(server as never, clientMock as never, new Headers());
		const tool = registered.find((item) => item.name === MCP_TOOL_NAME.saveCompanyNote)!;
		const missingRevision = await tool.handler({ id: "company-1", company: "Example", notes: "Replace" });
		expect(missingRevision.isError).toBe(true);
		expect(clientMock.library.companies.save).not.toHaveBeenCalled();
		clientMock.library.companies.save.mockRejectedValueOnce(new ORPCError("CONFLICT"));
		const staleRevision = await tool.handler({ id: "company-1", company: "Example", expectedRevision: 2, notes: "Merged" });
		expect(clientMock.library.companies.save).toHaveBeenCalledWith({ id: "company-1", company: "Example", expectedRevision: 2, notes: "Merged" });
		expect(staleRevision.isError).toBe(true);
		expect(staleRevision.content[0]!.text).toContain("Reread the document");
	});

	it("creates and duplicates with an automatically generated address", async () => {
		const { server, registered } = makeFakeServer();
		registerTools(server as never, clientMock as never, new Headers());
		clientMock.resume.create.mockResolvedValueOnce("created");
		clientMock.resume.duplicate.mockResolvedValueOnce("copied");
		const create = registered.find((tool) => tool.name === MCP_TOOL_NAME.createResume)!;
		const duplicate = registered.find((tool) => tool.name === MCP_TOOL_NAME.duplicateResume)!;
		await create.handler(TOOL_META[MCP_TOOL_NAME.createResume].inputSchema.parse({ name: "Resume" }));
		await duplicate.handler(TOOL_META[MCP_TOOL_NAME.duplicateResume].inputSchema.parse({ id: "r1" }));
		expect(clientMock.resume.create).toHaveBeenCalledWith({ name: "Resume", tags: [], withSampleData: false });
		expect(clientMock.resume.duplicate).toHaveBeenCalledWith({ id: "r1" });
	});

	it("imports applications with followUpAt coerced to Date and null preserved", async () => {
		clientMock.applications.import.mockResolvedValueOnce({ imported: 2 });
		const { server, registered } = makeFakeServer();
		registerTools(server as never, clientMock as never, new Headers());

		const tool = registered.find((item) => item.name === "import_applications")!;
		const result = await tool.handler({
			items: [
				{ company: "Acme", role: "Engineer", followUpAt: "2026-07-12T12:00:00.000Z" },
				{ company: "Beta", role: "Designer", followUpAt: null },
			],
		});

		expect(clientMock.applications.import).toHaveBeenCalledWith({
			items: [
				{ company: "Acme", role: "Engineer", followUpAt: new Date("2026-07-12T12:00:00.000Z") },
				{ company: "Beta", role: "Designer", followUpAt: null },
			],
		});
		expect(JSON.parse(result.content[0]!.text)).toEqual({ imported: 2 });
	});

	it("returns resume revision metadata and forwards the timestamp when patching", async () => {
		const updatedAt = new Date("2026-10-01T10:00:00.000Z");
		const resume = { id: "r1", name: "Resume", updatedAt, data: { basics: { name: "Before" } } };
		clientMock.resume.getById.mockResolvedValueOnce(resume);
		clientMock.resume.patch.mockResolvedValueOnce(resume);
		const { server, registered } = makeFakeServer();
		registerTools(server as never, clientMock as never, new Headers());
		const read = registered.find((tool) => tool.name === MCP_TOOL_NAME.getResume)!;
		const patch = registered.find((tool) => tool.name === MCP_TOOL_NAME.patchResume)!;
		const result = await read.handler({ id: "r1" });
		expect(result.structuredContent?.updatedAt).toBe("2026-10-01T10:00:00.000Z");
		expect(JSON.parse(result.content[0]!.text)).toEqual(resume.data);
		await patch.handler(
			TOOL_META[MCP_TOOL_NAME.patchResume].inputSchema.parse({
				id: "r1",
				expectedUpdatedAt: result.structuredContent?.updatedAt,
				operations: [{ op: "replace", path: "/basics/name", value: "After" }],
			}),
		);
		expect(clientMock.resume.patch.mock.calls[0]?.[0].expectedUpdatedAt).toEqual(updatedAt);
	});

	it("returns combined content, timestamps and metadata in both MCP representations", async () => {
		const { server, registered } = makeFakeServer();
		registerTools(server as never, clientMock as never, new Headers());
		const updatedAt = new Date("2026-10-19T06:00:00Z");
		const resume = { id: "draft", name: "Draft", updatedAt, applicationId: "job", data: { basics: { name: "Verified" } } };
		const libraryMetadata = { resumeId: "draft", updatedAt, sourceResumeId: "master", profile: { purpose: "tailored" } };
		clientMock.resume.getById.mockResolvedValueOnce(resume);
		clientMock.library.resumes.getMetadata.mockResolvedValueOnce(libraryMetadata);
		const read = registered.find((tool) => tool.name === MCP_TOOL_NAME.getResume)!;
		const result = await read.handler(TOOL_META[MCP_TOOL_NAME.getResume].inputSchema.parse({ id: "draft", includeMetadata: true }));
		expect(TOOL_META[MCP_TOOL_NAME.getResume].outputSchema.shape).toHaveProperty("libraryMetadata");
		expect(clientMock.library.resumes.getMetadata).toHaveBeenCalledWith({ resumeId: "draft" });
		expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
		expect(result.structuredContent).toMatchObject({
			id: "draft", updatedAt: updatedAt.toISOString(), applicationId: "job", data: resume.data,
			libraryMetadata: { sourceResumeId: "master", updatedAt: updatedAt.toISOString() },
		});
	});

	describe("error hints", () => {
		const readResume = (error: unknown) => {
			clientMock.resume.getById.mockRejectedValueOnce(error);

			const { server, registered } = makeFakeServer();
			registerTools(server as never, clientMock as never, new Headers());

			const tool = registered.find((item) => item.name === MCP_TOOL_NAME.getResume)!;
			return tool.handler({ id: "resume-1" });
		};

		it("hides unexpected internal failure details", async () => {
			const result = await readResume(new Error("postgresql://private-credentials/internal"));
			expect(result.isError).toBe(true);
			expect(result.content[0]!.text).toContain("Unexpected failure");
			expect(result.content[0]!.text).not.toContain("private-credentials");
		});

		// Procedures throw these without a message, so the message is the code itself
		// (or oRPC's default, "Not Found") and the status never appears in it.
		it.each([
			["RESUME_LOCKED", undefined, `Ask the user before unlocking with \`${MCP_TOOL_NAME.unlockResume}\`.`],
			[
				"NOT_FOUND",
				undefined,
				`\`${MCP_TOOL_NAME.listResumes}\`, \`${MCP_TOOL_NAME.listCoverLetters}\`, and \`${MCP_TOOL_NAME.listApplications}\` return valid ones.`,
			],
			["RESUME_SLUG_ALREADY_EXISTS", 400, "The slug is already in use."],
			["FORBIDDEN", undefined, "Permission denied."],
			["BAD_REQUEST", undefined, "Check the input parameters against the tool's schema."],
		])("hints on %s", async (code, status, expected) => {
			const result = await readResume(new ORPCError(code, status ? { status } : undefined));

			expect(result.isError).toBe(true);
			expect(result.content[0]!.text).toContain(expected);
		});
	});
});

