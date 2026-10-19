import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RouterClient } from "@orpc/server";
import type router from "@reactive-resume/api/routers";
import type z from "zod";
import { posix } from "node:path";
import { ORPCError } from "@orpc/server";
import { latexCompileChecksSchema } from "@reactive-resume/schema/resume/latex";
import { applyLatexTextEdits } from "./latex-edits";
import { MCP_TOOL_NAME as T } from "./mcp-tool-names";
import { finishQueuedResumeInput, prepareQueuedResumeInput } from "./queue-resume-meta";
import { prepareQueuedResume } from "./queue-session";
import { json, withErrorHandling } from "./results";
import { TOOL_META } from "./tool-meta";

type Client = RouterClient<typeof router>;
type Resume = Awaited<ReturnType<Client["resume"]["getById"]>>;

/** Return active source once, without old audit reports or unused alternative documents. */
export function queuedResumeSource(resume: Resume) {
	const project = resume.data.latex;
	const included = new Set<string>();
	if (project) {
		const pending = [project.entrypoint];
		while (pending.length) {
			const path = pending.pop()!;
			if (included.has(path)) continue;
			const file = project.files.find((candidate) => candidate.path === path && candidate.encoding === "utf-8");
			if (!file) continue;
			included.add(path);
			// Include static body dependencies, while leaving unrelated alternative resumes out of context.
			const source = file.content.replace(/(\\[\s\S])|%[^\r\n]*/g, (match, escaped: string | undefined) => escaped ?? " ".repeat(match.length));
			for (const match of source.matchAll(/\\(?:input|include)\s*\{([^{}]+)\}/g)) {
				let precedingSlashes = 0;
				for (let index = match.index - 1; index >= 0 && source[index] === "\\"; index--) precedingSlashes++;
				if (precedingSlashes % 2) continue;
				const name = match[1]!.trim();
				const dependency = /\.tex$/i.test(name) ? name : `${name}.tex`;
				pending.push(posix.normalize(dependency));
			}
		}
	}
	return {
		id: resume.id, name: resume.name, updatedAt: resume.updatedAt.toISOString(), applicationId: resume.applicationId,
		...(project ? {
			latex: {
				engine: project.engine, entrypoint: project.entrypoint,
				files: project.files.filter((file) => included.has(file.path)),
				omittedFiles: project.files.filter((file) => !included.has(file.path)).map((file) => file.path),
				partialProject: included.size < project.files.length,
			},
		} : { data: resume.data }),
	};
}

function compactPdfFailure(data: unknown) {
	if (!data || typeof data !== "object") return {};
	const details = data as Record<string, unknown>;
	const parsed = latexCompileChecksSchema.safeParse(details.checks);
	const checks = parsed.success ? parsed.data : null;
	return {
		compilationSucceeded: details.compilationSucceeded === true,
		...(checks ? {
			checks: {
				pageCount: checks.pageCount, expectedPageCount: checks.expectedPageCount,
				pageCountMatches: checks.pageCountMatches, pageCountError: checks.pageCountError,
				overfullBoxes: checks.overfullBoxes,
				textExtraction: {
					status: checks.textExtraction.status, characterCount: checks.textExtraction.characterCount,
					error: checks.textExtraction.error, pages: checks.textExtraction.pages,
				},
			},
		} : {}),
		...(typeof details.log === "string" ? { log: details.log.slice(0, 2_000) } : {}),
	};
}

/** All model-visible completion bookkeeping happens here; content and queue CAS checks remain server-enforced. */
export async function finishQueuedResume(client: Client, input: z.output<typeof finishQueuedResumeInput>) {
	const current = await client.applications.queue.read({ id: input.applicationId, includeDescription: false });
	// Renew validates this exact lease BEFORE editing, including expiry, revision and saved application status.
	const claim = await client.applications.queue.claim({
		id: input.applicationId, expectedRevision: current.preparation.revision, leaseToken: input.leaseToken,
	});
	const draftId = claim.item.preparation.draftResumeId;
	if (!draftId) throw new ORPCError("BAD_REQUEST", { message: "No prepared draft exists. Use prepare_queued_resume first." });
	const resume = await client.resume.getById({ id: draftId });
	if (resume.applicationId !== input.applicationId) throw new ORPCError("CONFLICT", { message: "The draft is no longer linked to this job." });
	if (resume.updatedAt.getTime() !== new Date(input.expectedUpdatedAt).getTime()) {
		throw new ORPCError("CONFLICT", { message: "The draft changed. Read its latest source before recomputing edits." });
	}
	if (!resume.data.latex) throw new ORPCError("BAD_REQUEST", { message: "This completion path requires a LaTeX draft. Use the ordinary resume tools for this document." });
	let updatedAt = resume.updatedAt;
	if (input.edits) {
		let changes: ReturnType<typeof applyLatexTextEdits>;
		try {
			changes = applyLatexTextEdits(resume.data.latex, { edits: input.edits, allowFormattingChanges: false });
		} catch (error) {
			throw new ORPCError("BAD_REQUEST", { message: error instanceof Error ? error.message : "Invalid exact edits." });
		}
		const paths = new Set(changes.changedFiles);
		const saved = await client.resume.patch({
			id: draftId, expectedUpdatedAt: resume.updatedAt,
			operations: changes.project.files.flatMap((file, index) => paths.has(file.path)
				? [{ op: "replace" as const, path: `/latex/files/${index}/content`, value: file.content }] : []),
		});
		updatedAt = saved.updatedAt;
	}
	const receipt = { applicationId: input.applicationId, draftResumeId: draftId, updatedAt: updatedAt.toISOString() };
	try {
		const item = await client.applications.queue.finish({
			id: input.applicationId, expectedRevision: claim.item.preparation.revision, leaseToken: claim.leaseToken,
			outcome: "ready", draftResumeId: draftId, expectedResumeUpdatedAt: updatedAt.toISOString(),
			verifyPdf: true, expectedPageCount: input.expectedPageCount,
			...(input.score !== undefined ? { score: input.score } : {}),
			...(input.notes !== undefined ? { notes: input.notes } : {}),
		});
		if (!item.pdfVerification) {
			return { success: false, ...receipt, saved: true, needsCorrection: false, error: "Completion returned no PDF verification receipt. Check saved queue progress before retrying." };
		}
		return { success: true, ...receipt, state: item.preparation.state, pdf: { verified: true, ...item.pdfVerification } };
	} catch (error) {
		// A saved edit is never lost from the receipt, so the assistant won't blindly resend old replacements.
		if (!(error instanceof ORPCError) || error.status >= 500) {
			return { success: false, ...receipt, saved: true, needsCorrection: false, error: "Draft saved; final verification did not complete. Refresh queue progress before retrying completion." };
		}
		const pdfFailure = error.code === "QUEUE_PDF_CHECK_FAILED";
		return {
			success: false, ...receipt, saved: true, needsCorrection: pdfFailure,
			error: error.message, code: error.code,
			...(pdfFailure ? compactPdfFailure(error.data) : {}),
		};
	}
}

export function registerQueueResumeTools(server: McpServer, client: Client) {
	server.registerTool(T.prepareQueuedResume, TOOL_META[T.prepareQueuedResume],
		withErrorHandling("preparing queued resume", async (params) => {
			const prepared = await prepareQueuedResume(client, prepareQueuedResumeInput.parse(params));
			const sameSource = JSON.stringify(prepared.baseResume.data) === JSON.stringify(prepared.draft.data);
			return json({
				applicationId: prepared.item.id, job: prepared.item, draft: queuedResumeSource(prepared.draft),
				base: { ...prepared.base, sameSourceAsDraft: sameSource, ...(!sameSource ? { source: queuedResumeSource(prepared.baseResume) } : {}) },
				leaseToken: prepared.leaseToken, context: prepared.context, warnings: prepared.warnings,
			});
		}));
	server.registerTool(T.finishQueuedResume, TOOL_META[T.finishQueuedResume],
		withErrorHandling("finishing queued resume", async (params) => {
			const result = await finishQueuedResume(client, finishQueuedResumeInput.parse(params));
			return { ...json(result), ...(!result.success ? { isError: true } : {}) };
		}));
}
