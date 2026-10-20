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
		description: "Read exact saved LaTeX source: active entrypoint by default, file manifest, updatedAt/applicationId and optional metadata. Other files are omitted, not deleted; use filePaths only for needed dependencies or evidence. Never replace the project from this partial view. For queued jobs prefer prepare_queued_resume, which returns source and job context together. Use server checks; do not create local files, run TeX/shell, calculate checksums or fetch PDFs during normal tailoring. No AI provider call.",
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
		description: "Standalone LaTeX text edit using exact replacements [{path,oldText,newText}] and expectedUpdatedAt. Each oldText must match once in the original saved source; edits cannot overlap. One guarded save preserves other files and existing template/layout. allowFormattingChanges=true only for a user-requested redesign. Returns updatedAt for subsequent work; reread only on conflict. For queued jobs prefer finish_queued_resume, which accepts section IDs or line ranges without repeating deleted source and runs server checks/progress together. No compilation or AI provider call here.",
		inputSchema: latexEditInput,
		outputSchema: z.object({
			id: z.string(), name: z.string(), updatedAt: z.iso.datetime({ offset: true }),
			appliedEdits: z.number().int(), changedFiles: z.array(z.string()), files: z.array(fileManifestSchema),
		}),
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
	},
} as const;
