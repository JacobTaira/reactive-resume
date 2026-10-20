import z from "zod";

const id = z.string().trim().min(1).max(100);
const document = z.object({ id, name: z.string(), updatedAt: z.date(), versionId: id.nullable() });

export const resumeComparisonDto = {
	input: z.object({ resumeId: id, sourceResumeId: id.optional(), sourceVersionId: id.optional() }),
	output: z.object({
		source: document,
		target: document,
		comparison: z.enum(["latex", "structured", "mixed"]),
		identical: z.boolean(),
		truncated: z.boolean(),
		files: z.array(z.object({
			path: z.string(),
			kind: z.enum(["added", "removed", "modified"]),
			binary: z.boolean(),
			addedLines: z.number().int().nonnegative(),
			removedLines: z.number().int().nonnegative(),
			coarse: z.boolean(),
			truncated: z.boolean(),
			lines: z.array(z.object({
				kind: z.enum(["added", "removed", "context"]),
				text: z.string(),
				oldLine: z.number().int().positive().nullable(),
				newLine: z.number().int().positive().nullable(),
			})),
		})),
	}),
};
