import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RouterClient } from "@orpc/server";
import type router from "@reactive-resume/api/routers";
import type z from "zod";
import { posix } from "node:path";
import { ORPCError } from "@orpc/server";
import { latexCompileChecksSchema } from "@reactive-resume/schema/resume/latex";
import { applyLatexTextEdits } from "./latex-edits";
import { applyLatexRegionEdits, latexSourceIndex } from "./latex-regions";
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
				files: project.files.filter((file) => included.has(file.path)).map((file) => ({
					path: file.path, encoding: file.encoding,
					...latexSourceIndex(file.path, file.content, file.path === project.entrypoint),
				})),
				omittedFiles: project.files.filter((file) => !included.has(file.path)).map((file) => file.path),
				partialProject: included.size < project.files.length,
				editPolicy: "Use section IDs or inclusive line ranges; send only new text. NUMBER| prefixes are display labels. Preamble, PDF metadata and header stay unchanged. Remove complete unwanted sections with their local spacing, without empty placeholders.",
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
	if (input.edits && (input.sectionEdits || input.lineEdits)) {
		throw new ORPCError("BAD_REQUEST", { message: "Use sectionEdits/lineEdits together, or legacy edits separately; do not combine these modes." });
	}
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
	let savedData = resume.data;
	if (input.edits || input.sectionEdits || input.lineEdits) {
		let changes: ReturnType<typeof applyLatexTextEdits>;
		try {
			changes = input.edits
				? applyLatexTextEdits(resume.data.latex, { edits: input.edits, allowFormattingChanges: false })
				: applyLatexRegionEdits(resume.data.latex, {
					...(input.sectionEdits ? { sectionEdits: input.sectionEdits } : {}),
					...(input.lineEdits ? { lineEdits: input.lineEdits } : {}),
				});
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
		savedData = { ...resume.data, latex: changes.project };
	}
	const receipt = { applicationId: input.applicationId, draftResumeId: draftId, updatedAt: updatedAt.toISOString() };
	try {
		if (!input.finalize) {
			const compiled = await client.resume.latex.compile({
				id: draftId, expectedUpdatedAt: updatedAt, expectedPageCount: input.expectedPageCount,
			});
			const checks = compiled.success ? compiled.checks : null;
			const mechanicalChecksPassed = Boolean(compiled.success && checks &&
				checks.pageCount === input.expectedPageCount && checks.textExtraction.status === "success" &&
				checks.textExtraction.text.trim());
			const [latestDraft, latestJob] = await Promise.all([
				client.resume.getById({ id: draftId }),
				client.applications.queue.read({ id: input.applicationId, includeDescription: false }),
			]);
			if (latestDraft.updatedAt.getTime() !== updatedAt.getTime() ||
				latestDraft.applicationId !== input.applicationId || latestJob.preparation.state !== "processing" ||
				latestJob.preparation.draftResumeId !== draftId) {
				throw new ORPCError("CONFLICT", { message: "Draft or queue changed during review compilation. Read current progress before continuing." });
			}
			return {
				success: mechanicalChecksPassed, ...receipt, saved: true, finalized: false,
				state: "processing" as const, reviewRequired: true, needsCorrection: !mechanicalChecksPassed,
				pdf: { verified: mechanicalChecksPassed, ...(checks ? { checks } : {}) },
				draft: queuedResumeSource(latestDraft),
				...(!mechanicalChecksPassed ? {
					code: "QUEUE_PDF_CHECK_FAILED",
					error: "Draft saved for review. Correct compilation, page count or text-extraction failures before finalizing.",
					...(!compiled.success ? { log: compiled.log.slice(-4_000) } : {}),
				} : {}),
			};
		}
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
		return { success: true, ...receipt, finalized: true, state: item.preparation.state, pdf: { verified: true, ...item.pdfVerification } };
	} catch (error) {
		// A saved edit is never lost from the receipt, so the assistant won't blindly resend old replacements.
		if (!(error instanceof ORPCError) || error.status >= 500) {
			return { success: false, ...receipt, saved: true, needsCorrection: false, error: "Draft saved; final verification did not complete. Refresh queue progress before retrying completion." };
		}
		const pdfFailure = error.code === "QUEUE_PDF_CHECK_FAILED";
		return {
			success: false, ...receipt, saved: true, needsCorrection: pdfFailure,
			error: error.message, code: error.code,
			...(pdfFailure ? {
				...compactPdfFailure(error.data),
				draft: queuedResumeSource({ ...resume, data: savedData, updatedAt }),
			} : {}),
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

