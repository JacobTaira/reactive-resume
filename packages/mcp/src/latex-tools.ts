import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RouterClient } from "@orpc/server";
import type router from "@reactive-resume/api/routers";
import { ORPCError } from "@orpc/server";
import { latexFileManifest } from "./latex-context";
import { applyLatexTextEdits } from "./latex-edits";
import { latexEditInput, latexReadInput } from "./latex-tool-meta";
import { MCP_TOOL_NAME as T } from "./mcp-tool-names";
import { json, withErrorHandling } from "./results";
import { readResumeContext } from "./resume-read";
import { TOOL_META } from "./tool-meta";

export function registerLatexTools(server: McpServer, client: RouterClient<typeof router>) {
	server.registerTool(
		T.readResumeLatex,
		TOOL_META[T.readResumeLatex],
		withErrorHandling("reading LaTeX source", async (params) => {
			const input = latexReadInput.parse(params);
			const resume = await readResumeContext(client, input);
			const project = resume.data.latex;
			if (!project) throw new ORPCError("BAD_REQUEST", { message: "This is an ordinary resume; use read_resume." });
			let files: ReturnType<typeof latexFileManifest>;
			try {
				files = latexFileManifest(project, input.filePaths);
			} catch (error) {
				throw new ORPCError("BAD_REQUEST", {
					message: error instanceof Error ? error.message : "Invalid project file selection.",
				});
			}
			return json({
				id: resume.id, name: resume.name, updatedAt: resume.updatedAt, applicationId: resume.applicationId,
				project: { engine: project.engine, entrypoint: project.entrypoint, files },
				...(resume.libraryMetadata ? { libraryMetadata: resume.libraryMetadata } : {}),
				partialProject: files.some((file) => !file.included),
			});
		}),
	);
	server.registerTool(
		T.editResumeLatex,
		TOOL_META[T.editResumeLatex],
		withErrorHandling("editing LaTeX text", async (params) => {
			const input = latexEditInput.parse(params);
			const resume = await client.resume.getById({ id: input.id });
			if (resume.updatedAt.getTime() !== new Date(input.expectedUpdatedAt).getTime()) {
				throw new ORPCError("CONFLICT", { message: "Resume changed. Read the latest source and recompute the edits." });
			}
			if (!resume.data.latex) throw new ORPCError("BAD_REQUEST", { message: "This resume has no LaTeX source." });
			let changes: ReturnType<typeof applyLatexTextEdits>;
			try {
				changes = applyLatexTextEdits(resume.data.latex, {
					edits: input.edits,
					allowFormattingChanges: input.allowFormattingChanges,
				});
			} catch (error) {
				throw new ORPCError("BAD_REQUEST", {
					message: error instanceof Error ? error.message : "Invalid LaTeX edits.",
				});
			}
			const paths = new Set(changes.changedFiles);
			const updated = await client.resume.patch({
				id: input.id, expectedUpdatedAt: new Date(input.expectedUpdatedAt),
				operations: changes.project.files.flatMap((file, index) => paths.has(file.path)
					? [{ op: "replace" as const, path: `/latex/files/${index}/content`, value: file.content }] : []),
			});
			return json({
				id: updated.id, name: updated.name, updatedAt: updated.updatedAt,
				appliedEdits: changes.appliedEdits, changedFiles: changes.changedFiles,
				files: latexFileManifest(changes.project, []).filter((file) => paths.has(file.path)),
			});
		}),
	);
}
