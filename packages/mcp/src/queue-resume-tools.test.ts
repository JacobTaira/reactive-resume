import { describe, expect, it, vi } from "vitest";
import { ORPCError } from "@orpc/server";
import { finishQueuedResumeInput } from "./queue-resume-meta";
import { finishQueuedResume, queuedResumeSource, registerQueueResumeTools } from "./queue-resume-tools";
import { MCP_TOOL_NAME as T } from "./mcp-tool-names";

vi.mock("./tool-meta", async () => {
	const { QUEUE_RESUME_META } = await import("./queue-resume-meta");
	return { TOOL_META: QUEUE_RESUME_META };
});

const initialAt = new Date("2026-10-19T07:35:50.957Z");
const savedAt = new Date("2026-10-19T07:36:12.100Z");
const leaseToken = "a".repeat(64);
const source = String.raw`\documentclass[10pt]{article}
\begin{document}
ACTIVE_RESUME_ONLY
Built a sensor pipeline.
Reviewed test results.
\input{parts/projects.tex}
\end{document}`;

function fixture() {
	const events: string[] = [];
	const project = {
		engine: "pdflatex", entrypoint: "main.tex", files: [
			{ path: "main.tex", encoding: "utf-8", content: source },
			{ path: "ACS.tex", encoding: "utf-8", content: "UNUSED_ALTERNATIVE_CONTENT" },
			{ path: "parts/projects.tex", encoding: "utf-8", content: "Documented system interfaces." },
			{ path: "template.sty", encoding: "utf-8", content: "SUPPORTING_STYLE" },
		],
	};
	const data = { latex: project, metadata: { notes: "PRIVATE_AUDIT_REPORT" } };
	const base = { id: "base", name: "Base Resume", applicationId: null, updatedAt: initialAt, data: structuredClone(data) };
	const draft = { id: "draft", name: "Example — Robotics Engineer", applicationId: "job", updatedAt: initialAt, data };
	const item = {
		id: "job", company: "Example", role: "Robotics Engineer", description: "Build robotics systems.",
		preparation: { state: "processing", revision: 7, draftResumeId: "draft" },
	};
	const pdfVerification = {
		pageCount: 1,
		overfullBoxes: { count: 0, messages: [] as string[], truncated: false },
		textExtractionStatus: "success" as const,
	};
	const client = {
		documents: {
			list: vi.fn(async () => [{
				id: "base", type: "resume", name: "Base Resume", updatedAt: initialAt,
				sourceResumeId: null, profile: null, application: null, trashedAt: null, tags: [],
			}]),
			copyForJob: vi.fn(async () => "draft"),
			linkApplication: vi.fn(),
		},
		resume: {
			getById: vi.fn(async ({ id }: { id: string }) => {
				events.push(`read:${id}`);
				if (id === "base") return base;
				if (id === "draft") return draft;
				throw new ORPCError("NOT_FOUND");
			}),
			patch: vi.fn(async (input: { operations: { path: string; value?: unknown }[] }) => {
				events.push("patch");
				for (const operation of input.operations) {
					const index = Number(operation.path.split("/")[3]);
					const file = draft.data.latex.files[index];
					if (file && typeof operation.value === "string") file.content = operation.value;
				}
				draft.updatedAt = savedAt;
				return draft;
			}),
			latex: { compile: vi.fn() },
		},
		applications: {
			queue: {
				read: vi.fn(async () => { events.push("queue.read"); return item; }),
				claim: vi.fn(async () => {
					events.push("claim");
					return { item: { ...item, preparation: { ...item.preparation, revision: 8 } }, leaseToken };
				}),
				update: vi.fn(async () => ({ ...item, preparation: { ...item.preparation, revision: 9 } })),
				finish: vi.fn(async (_input: Record<string, unknown>) => {
					events.push("finish");
					return { ...item, preparation: { ...item.preparation, state: "ready", revision: 9 }, pdfVerification };
				}),
			},
		},
		library: {
			companies: { list: vi.fn(async () => []), getById: vi.fn() },
			resumes: { setMetadata: vi.fn(), getMetadata: vi.fn(), index: vi.fn() },
		},
	};
	return { client, events, base, draft, item, pdfVerification };
}

const edits = [
	{ path: "main.tex", oldText: "Built a sensor pipeline.", newText: "Implemented a verified sensor pipeline." },
	{ path: "parts/projects.tex", oldText: "Documented system interfaces.", newText: "Documented typed system interfaces." },
];
function input(extra: Record<string, unknown> = {}) {
	return finishQueuedResumeInput.parse({
		applicationId: "job", leaseToken, expectedUpdatedAt: initialAt.toISOString(), edits,
		...extra,
	});
}

function registered(client: unknown) {
	const handlers = new Map<string, (params: unknown) => Promise<{
		structuredContent?: Record<string, unknown>;
		isError?: boolean;
	}>>();
	const server = {
		registerTool: (name: string, _metadata: unknown, handler: (params: unknown) => Promise<{
			structuredContent?: Record<string, unknown>;
			isError?: boolean;
		}>) => handlers.set(name, handler),
	};
	registerQueueResumeTools(server as never, client as never);
	return (name: string) => {
		const handler = handlers.get(name);
		if (!handler) throw new Error(`Missing tool: ${name}`);
		return handler;
	};
}

describe("compact queued-resume tools", () => {
	it("prepares one active source without duplicating Base content, unused alternatives or audit profiles", async () => {
		const { client } = fixture();
		const result = await registered(client)(T.prepareQueuedResume)({ applicationId: "job" });
		const body = result.structuredContent;
		const serialized = JSON.stringify(body);

		expect(result.isError).not.toBe(true);
		expect(body).toMatchObject({ applicationId: "job", base: { id: "base", sameSourceAsDraft: true } });
		expect(serialized.split("ACTIVE_RESUME_ONLY")).toHaveLength(2);
		expect(serialized).not.toContain("UNUSED_ALTERNATIVE_CONTENT");
		expect(serialized).not.toContain("PRIVATE_AUDIT_REPORT");
		expect(body?.base).not.toHaveProperty("source");
		expect(client.documents.linkApplication).not.toHaveBeenCalled();
		expect(client.library.resumes.getMetadata).not.toHaveBeenCalled();
	});

	it("keeps original Base facts available when resuming an already tailored draft", async () => {
		const { client, draft } = fixture();
		const main = draft.data.latex.files[0];
		if (!main) throw new Error("Missing fixture source");
		main.content = source.replace("ACTIVE_RESUME_ONLY", "EXISTING_TAILORED_DRAFT");

		const result = await registered(client)(T.prepareQueuedResume)({ applicationId: "job" });

		expect(result.structuredContent?.base).toMatchObject({ sameSourceAsDraft: false, source: { id: "base" } });
		expect(JSON.stringify(result.structuredContent).split("ACTIVE_RESUME_ONLY")).toHaveLength(2);
		expect(JSON.stringify(result.structuredContent).split("EXISTING_TAILORED_DRAFT")).toHaveLength(2);
	});

	it("includes nested body dependencies once, follows project-root paths and terminates cycles", () => {
		const { draft } = fixture();
		const parts = draft.data.latex.files.find((file) => file.path === "parts/projects.tex");
		if (!parts) throw new Error("Missing fixture dependency");
		parts.content = String.raw`NESTED_PROJECT_EVIDENCE
\input{parts/deep}
\include{chapters/history}
% \input{ACS}`;
		draft.data.latex.files.push(
			{ path: "parts/deep.tex", encoding: "utf-8", content: String.raw`NESTED_DEEP_EVIDENCE \input{parts/projects}` },
			{ path: "chapters/history.tex", encoding: "utf-8", content: "PAST_RESEARCH_EVIDENCE" },
		);

		const result = queuedResumeSource(draft as never);
		const latex = result.latex;
		if (!latex) throw new Error("Missing LaTeX output");

		expect(latex.files.map((file) => file.path)).toEqual([
			"main.tex", "parts/projects.tex", "parts/deep.tex", "chapters/history.tex",
		]);
		expect(latex.omittedFiles).toEqual(["ACS.tex", "template.sty"]);
		expect(latex.partialProject).toBe(true);
		for (const marker of ["NESTED_PROJECT_EVIDENCE", "NESTED_DEEP_EVIDENCE", "PAST_RESEARCH_EVIDENCE"]) {
			expect(JSON.stringify(latex.files).split(marker)).toHaveLength(2);
		}
	});

	it("does not load alternative documents mentioned only in comments or escaped input examples", () => {
		const { draft } = fixture();
		const main = draft.data.latex.files[0];
		if (!main) throw new Error("Missing fixture source");
		main.content = String.raw`\documentclass{article}
\begin{document}
% \input{ACS}
\\input{ACS}
\% Escaped percent keeps the real dependency active: \input{parts/projects}
\end{document}`;

		const result = queuedResumeSource(draft as never);
		const latex = result.latex;
		if (!latex) throw new Error("Missing LaTeX output");

		expect(latex.files.map((file) => file.path)).toEqual(["main.tex", "parts/projects.tex"]);
		expect(JSON.stringify(latex.files)).not.toContain("UNUSED_ALTERNATIVE_CONTENT");
	});

	it("validates the claim, saves one exact batch and verifies the resulting saved snapshot", async () => {
		const { client, events, draft } = fixture();
		const supportingFiles = structuredClone(draft.data.latex.files.filter((file) => file.path === "ACS.tex" || file.path === "template.sty"));

		const result = await finishQueuedResume(client as never, input());

		expect(events).toEqual(["queue.read", "claim", "read:draft", "patch", "finish"]);
		expect(client.resume.patch).toHaveBeenCalledOnce();
		expect(client.resume.patch.mock.calls[0]?.[0].operations.map((operation) => operation.path))
			.toEqual(["/latex/files/0/content", "/latex/files/2/content"]);
		expect(draft.data.latex.files.filter((file) => file.path === "ACS.tex" || file.path === "template.sty")).toEqual(supportingFiles);
		expect(client.applications.queue.finish).toHaveBeenCalledWith({
			id: "job", expectedRevision: 8, leaseToken, outcome: "ready", draftResumeId: "draft",
			expectedResumeUpdatedAt: savedAt.toISOString(), verifyPdf: true, expectedPageCount: 1,
		});
		expect(result).toMatchObject({ success: true, updatedAt: savedAt.toISOString(), state: "ready" });
		expect(client.resume.latex.compile).not.toHaveBeenCalled();
		expect(client.library.resumes.setMetadata).not.toHaveBeenCalled();
		expect(client.applications.queue.finish.mock.calls[0]?.[0]).not.toHaveProperty("score");
	});

	it("does not edit after a missing, expired or competing claim", async () => {
		const { client } = fixture();
		client.applications.queue.claim.mockRejectedValue(new ORPCError("CONFLICT"));

		await expect(finishQueuedResume(client as never, input())).rejects.toMatchObject({ code: "CONFLICT" });
		expect(client.resume.getById).not.toHaveBeenCalled();
		expect(client.resume.patch).not.toHaveBeenCalled();
		expect(client.applications.queue.finish).not.toHaveBeenCalled();
	});

	it("does not edit a changed or differently linked draft", async () => {
		for (const failure of ["stale", "link"]) {
			const { client, draft } = fixture();
			if (failure === "stale") draft.updatedAt = savedAt;
			else draft.applicationId = "another-job";

			await expect(finishQueuedResume(client as never, input())).rejects.toMatchObject({ code: "CONFLICT" });
			expect(client.resume.patch).not.toHaveBeenCalled();
			expect(client.applications.queue.finish).not.toHaveBeenCalled();
		}
	});

	it("does not compile or finish after a concurrent save rejects the patch", async () => {
		const { client } = fixture();
		client.resume.patch.mockRejectedValue(new ORPCError("CONFLICT"));

		await expect(finishQueuedResume(client as never, input())).rejects.toMatchObject({ code: "CONFLICT" });
		expect(client.applications.queue.finish).not.toHaveBeenCalled();
	});

	it("retains the saved timestamp and bounded correction diagnostics after PDF checks fail", async () => {
		const { client } = fixture();
		client.applications.queue.finish.mockRejectedValue(new ORPCError("QUEUE_PDF_CHECK_FAILED", {
			status: 400, message: "PDF has 2 pages; target is 1.",
			data: {
				compilationSucceeded: true, pdf: "PRIVATE_PDF_BYTES", log: `${"x".repeat(2_001)}UNBOUNDED_LOG_TAIL`,
				checks: {
					pageCount: 2, expectedPageCount: 1, pageCountMatches: false, pageCountError: null,
					overfullBoxes: { count: 0, messages: [], truncated: false },
					textExtraction: {
						status: "success", characterCount: 200, text: "FULL_PDF_TEXT_TO_OMIT", preview: "FULL_PREVIEW_TO_OMIT",
						truncated: false, error: null,
						pages: [{ page: 2, characterCount: 30, lineCount: 2, firstLines: "Overflow bullet", lastLines: "Last line" }],
					},
				},
			},
		}));

		const result = await registered(client)(T.finishQueuedResume)(input());
		const body = result.structuredContent;

		expect(result.isError).toBe(true);
		expect(body).toMatchObject({ success: false, saved: true, needsCorrection: true, updatedAt: savedAt.toISOString() });
		expect(body?.checks).toMatchObject({ pageCount: 2, textExtraction: { pages: [{ page: 2, lastLines: "Last line" }] } });
		expect(String(body?.log)).toHaveLength(2_000);
		for (const omitted of ["PRIVATE_PDF_BYTES", "FULL_PDF_TEXT_TO_OMIT", "FULL_PREVIEW_TO_OMIT", "UNBOUNDED_LOG_TAIL"]) {
			expect(JSON.stringify(body)).not.toContain(omitted);
		}
	});

	it("can recheck saved source without applying the old replacements a second time", async () => {
		const { client } = fixture();

		const result = await finishQueuedResume(client as never, input({ edits: undefined }));

		expect(result).toMatchObject({ success: true, updatedAt: initialAt.toISOString() });
		expect(client.resume.patch).not.toHaveBeenCalled();
		expect(client.applications.queue.finish).toHaveBeenCalledWith({
			id: "job", expectedRevision: 8, leaseToken, outcome: "ready", draftResumeId: "draft",
			expectedResumeUpdatedAt: initialAt.toISOString(), verifyPdf: true, expectedPageCount: 1,
		});
	});

	it("saves only an optional brief score and notes without a separate evaluation workflow", async () => {
		const { client } = fixture();

		await finishQueuedResume(client as never, input({ score: 84, notes: "No verified flight-test experience." }));

		expect(client.applications.queue.finish.mock.calls[0]?.[0]).toMatchObject({ score: 84, notes: "No verified flight-test experience." });
		expect(client.library.resumes.setMetadata).not.toHaveBeenCalled();
		expect(client.library.resumes.getMetadata).not.toHaveBeenCalled();
	});

	it("returns measured page count and unresolved overflow warnings from server verification", async () => {
		const { client, pdfVerification } = fixture();
		pdfVerification.overfullBoxes.count = 1;
		pdfVerification.overfullBoxes.messages.push("Overfull \\hbox (2pt too wide)");

		const result = await finishQueuedResume(client as never, input());

		expect(result).toMatchObject({
			success: true,
			pdf: { verified: true, pageCount: 1, overfullBoxes: { count: 1, messages: ["Overfull \\hbox (2pt too wide)"] } },
		});
	});

	it("does not report verified success if an older server omits its PDF receipt", async () => {
		const { client, item } = fixture();
		client.applications.queue.finish.mockResolvedValue({ ...item, preparation: { ...item.preparation, state: "ready" } } as never);

		const result = await finishQueuedResume(client as never, input());

		expect(result).toMatchObject({ success: false, saved: true, needsCorrection: false, updatedAt: savedAt.toISOString() });
	});

	it("rejects missing, overlapping and template-changing edits before persistence", async () => {
		const invalidEdits = [
			[{ path: "main.tex", oldText: "Not in this source", newText: "New text" }],
			[
				{ path: "main.tex", oldText: "Built a sensor pipeline.", newText: "Changed bullet." },
				{ path: "main.tex", oldText: "sensor pipeline", newText: "data pipeline" },
			],
			[{ path: "main.tex", oldText: "[10pt]", newText: "[9pt]" }],
		];
		for (const invalid of invalidEdits) {
			const { client, draft } = fixture();
			const original = JSON.stringify(draft.data);

			await expect(finishQueuedResume(client as never, input({ edits: invalid }))).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(client.resume.patch).not.toHaveBeenCalled();
			expect(client.applications.queue.finish).not.toHaveBeenCalled();
			expect(JSON.stringify(draft.data)).toBe(original);
		}
	});
});
