import z from "zod";

export const LATEX_LIMITS = {
	files: 100,
	fileBytes: 2 * 1024 * 1024,
	projectBytes: 8 * 1024 * 1024,
	archiveBytes: 8 * 1024 * 1024,
} as const;

const extensions = new Set([
	"tex", "sty", "cls", "clo", "cfg", "def", "bib", "bst", "bbl", "png", "jpg", "jpeg", "pdf", "eps",
	"tfm", "enc", "map", "pfb", "afm", "txt", "md",
]);

export const latexPathSchema = z.string().min(1).max(240).refine((path) => {
	const parts = path.split("/");
	return parts.every((part) => /^[A-Za-z0-9][A-Za-z0-9 _.-]*$/.test(part)) &&
		extensions.has(path.split(".").at(-1)?.toLowerCase() ?? "") && parts[0] !== "rr-build";
}, "Use a supported project file with a safe relative path.");

export const latexFileSchema = z.object({
	path: latexPathSchema,
	encoding: z.enum(["utf-8", "base64"]),
	content: z.string().max(LATEX_LIMITS.fileBytes * 2),
});

export const latexProjectSchema = z.object({
	engine: z.literal("pdflatex"),
	entrypoint: latexPathSchema.refine((path) => path.toLowerCase().endsWith(".tex"), "Choose a .tex main document."),
	files: z.array(latexFileSchema).min(1).max(LATEX_LIMITS.files),
}).superRefine((project, context) => {
	const paths = new Set<string>();
	let total = 0;
	for (const [index, file] of project.files.entries()) {
		const key = file.path.toLowerCase();
		if (paths.has(key)) context.addIssue({ code: "custom", path: ["files", index, "path"], message: "Duplicate file path." });
		paths.add(key);
		if (file.encoding === "base64" && !z.base64().safeParse(file.content).success) {
			context.addIssue({ code: "custom", path: ["files", index, "content"], message: "Invalid base64 file." });
		}
		const size = file.encoding === "utf-8" ? new TextEncoder().encode(file.content).byteLength :
			file.content.length * 3 / 4 - (file.content.endsWith("==") ? 2 : file.content.endsWith("=") ? 1 : 0);
		total += size;
		if (size > LATEX_LIMITS.fileBytes) context.addIssue({ code: "custom", path: ["files", index], message: "File exceeds 2 MiB." });
	}
	if (total > LATEX_LIMITS.projectBytes) context.addIssue({ code: "custom", message: "Project exceeds 8 MiB." });
	if (!project.files.some((file) => file.path === project.entrypoint)) {
		context.addIssue({ code: "custom", path: ["entrypoint"], message: "Main document is missing." });
	}
	for (const file of project.files) {
		const segments = file.path.toLowerCase().split("/");
		for (let index = 1; index < segments.length; index++) {
			if (paths.has(segments.slice(0, index).join("/"))) context.addIssue({ code: "custom", message: "Conflicting file and directory paths." });
		}
	}
});

export type LatexProject = z.infer<typeof latexProjectSchema>;
export type LatexFile = z.infer<typeof latexFileSchema>;

export const latexCompileOptionsSchema = z.object({
	expectedPageCount: z.number().int().min(1).max(100).optional(),
});

export const latexCompileChecksSchema = z.object({
	pageCount: z.number().int().positive().nullable(),
	expectedPageCount: z.number().int().min(1).max(100).nullable(),
	pageCountMatches: z.boolean().nullable(),
	pageCountError: z.string().max(500).nullable(),
	overfullBoxes: z.object({
		count: z.number().int().nonnegative(),
		messages: z.array(z.string().max(500)).max(20),
		truncated: z.boolean(),
	}),
	textExtraction: z.object({
		status: z.enum(["success", "empty", "failed", "unavailable"]),
		characterCount: z.number().int().nonnegative().nullable(),
		text: z.string().max(50_000),
		preview: z.string().max(1_000),
		truncated: z.boolean(),
		error: z.string().max(500).nullable(),
	}),
});

export type LatexCompileOptions = z.infer<typeof latexCompileOptionsSchema>;
export type LatexCompileChecks = z.infer<typeof latexCompileChecksSchema>;

export const latexCompileResultSchema = z.discriminatedUnion("success", [
	// An older worker can still compile; clients must explicitly report its missing checks as unavailable.
	z.object({ success: z.literal(true), pdf: z.base64(), log: z.string(), checks: latexCompileChecksSchema.optional() }),
	z.object({ success: z.literal(false), log: z.string() }),
]);
