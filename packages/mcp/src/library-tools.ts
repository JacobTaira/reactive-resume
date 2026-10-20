import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RouterClient } from "@orpc/server";
import type router from "@reactive-resume/api/routers";
import { libraryDto } from "@reactive-resume/api/dto/library";
import { resumeComparisonDto } from "@reactive-resume/api/dto/resume-comparison";
import { moveResumeInput } from "./library-tool-meta";
import { MCP_TOOL_NAME as T } from "./mcp-tool-names";
import { json, text, withErrorHandling } from "./results";
import { TOOL_META } from "./tool-meta";

export function registerLibraryTools(server: McpServer, client: RouterClient<typeof router>) {
	server.registerTool(
		T.listResumeFolders,
		TOOL_META[T.listResumeFolders],
		withErrorHandling("listing resume folders", async (params) =>
			json(await client.library.folders.list(libraryDto.folders.list.input.parse(params))),
		),
	);
	server.registerTool(
		T.createResumeFolder,
		TOOL_META[T.createResumeFolder],
		withErrorHandling("creating resume folder", async (params) =>
			json(await client.library.folders.create(libraryDto.folders.create.input.parse(params))),
		),
	);
	server.registerTool(
		T.updateResumeFolder,
		TOOL_META[T.updateResumeFolder],
		withErrorHandling("updating resume folder", async (params) =>
			json(await client.library.folders.update(libraryDto.folders.update.input.parse(params))),
		),
	);
	server.registerTool(
		T.deleteResumeFolder,
		TOOL_META[T.deleteResumeFolder],
		withErrorHandling("deleting resume folder", async (params) => {
			await client.library.folders.delete(libraryDto.folders.delete.input.parse(params));
			return text(
				"Deleted folder. Its resumes and child folders moved to the deleted folder's parent; their content was preserved.",
			);
		}),
	);
	server.registerTool(
		T.moveResume,
		TOOL_META[T.moveResume],
		withErrorHandling("moving resume", async (params) =>
			json(await client.library.resumes.setMetadata(moveResumeInput.parse(params))),
		),
	);
	server.registerTool(
		T.listCompanyNotes,
		TOOL_META[T.listCompanyNotes],
		withErrorHandling("finding company research", async (params) =>
			json(await client.library.companies.list(libraryDto.companies.list.input.parse(params))),
		),
	);
	server.registerTool(
		T.readCompanyNote,
		TOOL_META[T.readCompanyNote],
		withErrorHandling("reading company research", async (params) =>
			json(await client.library.companies.getById(libraryDto.companies.getById.input.parse(params))),
		),
	);
	server.registerTool(
		T.saveCompanyNote,
		TOOL_META[T.saveCompanyNote],
		withErrorHandling("saving company research", async (params) =>
			json(await client.library.companies.save(libraryDto.companies.save.input.parse(params))),
		),
	);
	server.registerTool(
		T.deleteCompanyNote,
		TOOL_META[T.deleteCompanyNote],
		withErrorHandling("deleting company research", async (params) => {
			await client.library.companies.delete(libraryDto.companies.delete.input.parse(params));
			return text("Deleted company research document. Its linked resumes remain saved.");
		}),
	);
	server.registerTool(
		T.readResumeMetadata,
		TOOL_META[T.readResumeMetadata],
		withErrorHandling("reading resume metadata", async (params) =>
			json(await client.library.resumes.getMetadata(libraryDto.resumes.getMetadata.input.parse(params))),
		),
	);
	server.registerTool(
		T.updateResumeMetadata,
		TOOL_META[T.updateResumeMetadata],
		withErrorHandling("updating resume metadata", async (params) =>
			json(await client.library.resumes.setMetadata(libraryDto.resumes.setMetadata.input.parse(params))),
		),
	);
	server.registerTool(
		T.findRelatedResumes,
		TOOL_META[T.findRelatedResumes],
		withErrorHandling("finding related resumes", async (params) =>
			json(await client.library.resumes.index(libraryDto.resumes.index.input.parse(params))),
		),
	);
	server.registerTool(
		T.findRelatedJobs,
		TOOL_META[T.findRelatedJobs],
		withErrorHandling("finding related jobs", async (params) =>
			json(await client.library.jobs.index(libraryDto.jobs.index.input.parse(params))),
		),
	);
	server.registerTool(
		T.compareResumes,
		TOOL_META[T.compareResumes],
		withErrorHandling("comparing resume sources", async (params) =>
			json(await client.library.resumes.compare(resumeComparisonDto.input.parse(params))),
		),
	);
}
