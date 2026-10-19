import z from "zod";
import { libraryDto } from "@reactive-resume/api/dto/library";
import { latexPathSchema } from "@reactive-resume/schema/resume/latex";
import { toWireObjectSchema } from "./contracts";
import { latexTextEditsSchema } from "./latex-edits";
import { MCP_TOOL_NAME as T } from "./mcp-tool-names";

export const latexReadInput = z.strictObject({
	id: z.string().min(1),
	filePaths: z.array(latexPathSchema).min(1).max(100).optional(),
	includeMetadata: z.boolean().default(true),
});
export const latexEditInput = latexTextEditsSchema.extend({
	id: z.string().min(1),
	expectedUpdatedAt: z.iso.datetime({ offset: true }),
}).strict();

const fileManifestSchema = z.object({
	index: z.number().int().nonnegative(),
	path: z.string(),
	encoding: z.enum(["utf-8", "base64"]),
	byteLength: z.number().int().nonnegative(),
	sha256: z.string(),
	included: z.boolean(),
	content: z.string().optional(),
});

export const LATEX_TOOL_META = {
	[T.readResumeLatex]: {
		title: "Read LaTeX Resume Source",
		description: "Preferred evidence read for a LaTeX resume. Returns the saved entrypoint's exact source by default, a manifest of every project file with original index/size/SHA-256, current updatedAt/applicationId, and optional libraryMetadata (included by default). Other file contents are explicitly omitted, not deleted or empty; request filePaths for included dependencies or relevant supporting evidence when needed. An unused alternative such as ACS.tex need not be retransmitted. Never replace the project using this partial view. Save exact returned UTF-8 bytes and verify SHA-256 before local pdflatex; do not retype the preamble. A local compile is optional preliminary page-fit work, and the final server compile remains authoritative. Does not call an AI provider.",
		inputSchema: latexReadInput,
		outputSchema: toWireObjectSchema(z.object({
			id: z.string(), name: z.string(), updatedAt: z.date(), applicationId: z.string().nullable(),
			project: z.object({ engine: z.literal("pdflatex"), entrypoint: z.string(), files: z.array(fileManifestSchema) }),
			libraryMetadata: libraryDto.resumes.getMetadata.output.optional(),
			partialProject: z.boolean(),
		})),
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	},
	[T.editResumeLatex]: {
		title: "Edit LaTeX Resume Text",
		description: "Preferred LaTeX content edit: send small exact replacements [{path,oldText,newText}] instead of resending an entire .tex file. Each oldText must occur exactly once in the ORIGINAL saved source; edits must not overlap. All edits validate before one version-guarded save, preserving other project files. expectedUpdatedAt is required. Default protection preserves the preamble and known layout declarations; allowFormattingChanges=true only when the user explicitly requested template/layout changes. Returns a compact receipt with updatedAt and changed-file hashes, not the whole resume; reuse that timestamp for the next edit/compile instead of rereading unchanged source. On conflict reread/recompute. No compilation, AI provider or application submission occurs.",
		inputSchema: latexEditInput,
		outputSchema: z.object({
			id: z.string(), name: z.string(), updatedAt: z.iso.datetime({ offset: true }),
			appliedEdits: z.number().int(), changedFiles: z.array(z.string()), files: z.array(fileManifestSchema),
		}),
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
	},
} as const;
