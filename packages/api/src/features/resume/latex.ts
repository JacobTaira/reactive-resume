import z from "zod";
import { env } from "@reactive-resume/env/server";
import { latexCompileOptionsSchema, latexCompileResultSchema, latexProjectSchema } from "@reactive-resume/schema/resume/latex";
import { protectedProcedure } from "../../context";
import { pdfAnalysisRateLimit, pdfExportRateLimit } from "../../middleware/rate-limit";
import { resolveLatexCompileSnapshot } from "./compile-snapshot";
import { compileLatexProject, unpackLatexArchive } from "./latex-compiler";
import { resumeService } from "./service";

export const latexRouter = {
	render: protectedProcedure
		.route({ method: "POST", path: "/latex/previews", tags: ["LaTeX"], summary: "Preview a supplied LaTeX project" })
		.input(z.object({ project: latexProjectSchema, ...latexCompileOptionsSchema.shape }))
		.output(latexCompileResultSchema)
		.use(pdfAnalysisRateLimit)
		.handler(({ input }) => compileLatexProject(input.project, input)),
	status: protectedProcedure
		.route({ method: "GET", path: "/latex/status", tags: ["LaTeX"], summary: "Read LaTeX availability" })
		.output(z.object({ configured: z.boolean() }))
		.handler(() => ({ configured: Boolean(env.LATEX_COMPILER_URL && env.LATEX_COMPILER_TOKEN) })),
	unpack: protectedProcedure
		.route({ method: "POST", path: "/latex/imports", tags: ["LaTeX"], summary: "Read an Overleaf source ZIP" })
		.input(z.object({ archive: z.base64().max(12 * 1024 * 1024) }))
		.output(latexProjectSchema)
		.use(pdfAnalysisRateLimit)
		.handler(({ input }) => unpackLatexArchive(input.archive)),
	compile: protectedProcedure
		.route({ method: "POST", path: "/resumes/{id}/latex/compilations", tags: ["LaTeX"], summary: "Compile a LaTeX resume" })
		.input(z.object({
			id: z.string().min(1),
			project: latexProjectSchema.optional(),
			expectedUpdatedAt: z.coerce.date().optional(),
			...latexCompileOptionsSchema.shape,
		}))
		.output(latexCompileResultSchema.and(z.object({ resumeUpdatedAt: z.date().nullable() })))
		.use(pdfExportRateLimit)
		.handler(async ({ input, context }) => {
			// Authorize before compiling even when previewing an unsaved source draft.
			const resume = await resumeService.getById({ id: input.id, userId: context.user.id });
			const snapshot = resolveLatexCompileSnapshot(resume, input);
			const result = await compileLatexProject(snapshot.project, input);
			return { ...result, resumeUpdatedAt: snapshot.resumeUpdatedAt };
		}),
};
