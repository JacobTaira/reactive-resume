import { protectedProcedure } from "../../context";
import { libraryDto } from "../../dto/library";
import { resumeMutationRateLimit } from "../../middleware/rate-limit";
import { libraryService } from "./service";

const route = (method: "GET" | "POST" | "DELETE", path: `/${string}`, operationId: string, summary: string) => ({
	method, path, operationId, summary, tags: ["Library"], description: `${summary}. Requires authentication; every resource is scoped to the current account.`,
});

export const libraryRouter = {
	folders: {
		list: protectedProcedure.route(route("GET", "/library/folders", "listResumeFolders", "List nested resume folders"))
			.input(libraryDto.folders.list.input).output(libraryDto.folders.list.output)
			.handler(({ context }) => libraryService.folders.list(context.user.id)),
		create: protectedProcedure.route(route("POST", "/library/folders", "createResumeFolder", "Create a resume folder"))
			.input(libraryDto.folders.create.input).output(libraryDto.folders.create.output).use(resumeMutationRateLimit)
			.handler(({ context, input }) => libraryService.folders.create({ ...input, userId: context.user.id })),
		update: protectedProcedure.route(route("POST", "/library/folders/update", "updateResumeFolder", "Rename or move a resume folder"))
			.input(libraryDto.folders.update.input).output(libraryDto.folders.update.output).use(resumeMutationRateLimit)
			.handler(({ context, input }) => libraryService.folders.update({ ...input, userId: context.user.id })),
		delete: protectedProcedure.route(route("DELETE", "/library/folders/{id}", "deleteResumeFolder", "Remove a folder and move its contents to its parent"))
			.input(libraryDto.folders.delete.input).output(libraryDto.folders.delete.output).use(resumeMutationRateLimit)
			.handler(({ context, input }) => libraryService.folders.delete({ ...input, userId: context.user.id })),
	},
	companies: {
		list: protectedProcedure.route(route("GET", "/library/companies", "listCompanyResearch", "Search company research summaries"))
			.input(libraryDto.companies.list.input).output(libraryDto.companies.list.output)
			.handler(({ context, input }) => libraryService.companies.list({ ...input, userId: context.user.id })),
		getById: protectedProcedure.route(route("GET", "/library/companies/{id}", "getCompanyResearch", "Read a company research document"))
			.input(libraryDto.companies.getById.input).output(libraryDto.companies.getById.output)
			.handler(({ context, input }) => libraryService.companies.getById({ ...input, userId: context.user.id })),
		save: protectedProcedure.route(route("POST", "/library/companies", "saveCompanyResearch", "Create or update a company research document with revision protection"))
			.input(libraryDto.companies.save.input).output(libraryDto.companies.save.output).use(resumeMutationRateLimit)
			.handler(({ context, input }) => libraryService.companies.save({ ...input, userId: context.user.id })),
		delete: protectedProcedure.route(route("DELETE", "/library/companies/{id}", "deleteCompanyResearch", "Delete a company note without deleting resumes"))
			.input(libraryDto.companies.delete.input).output(libraryDto.companies.delete.output).use(resumeMutationRateLimit)
			.handler(({ context, input }) => libraryService.companies.delete({ ...input, userId: context.user.id })),
	},
	resumes: {
		getMetadata: protectedProcedure.route(route("GET", "/library/resumes/{resumeId}/metadata", "getResumeLibraryMetadata", "Read a resume's folder, lineage, job context, and evaluation"))
			.input(libraryDto.resumes.getMetadata.input).output(libraryDto.resumes.getMetadata.output)
			.handler(({ context, input }) => libraryService.resumes.getMetadata({ ...input, userId: context.user.id })),
		setMetadata: protectedProcedure.route(route("POST", "/library/resumes/{resumeId}/metadata", "setResumeLibraryMetadata", "Organize a resume and update agent metadata without changing its content"))
			.input(libraryDto.resumes.setMetadata.input).output(libraryDto.resumes.setMetadata.output).use(resumeMutationRateLimit)
			.handler(({ context, input }) => libraryService.resumes.setMetadata({ ...input, userId: context.user.id })),
		index: protectedProcedure.route(route("GET", "/library/resumes", "indexRelatedResumes", "Find related resumes using compact metadata and lexical reuse hints"))
			.input(libraryDto.resumes.index.input).output(libraryDto.resumes.index.output)
			.handler(({ context, input }) => libraryService.resumes.index({ ...input, userId: context.user.id })),
	},
	jobs: {
		index: protectedProcedure.route(route("GET", "/library/jobs", "indexRelatedJobs", "Find related saved jobs without loading full job descriptions"))
			.input(libraryDto.jobs.index.input).output(libraryDto.jobs.index.output)
			.handler(({ context, input }) => libraryService.jobs.index({ ...input, userId: context.user.id })),
	},
};
