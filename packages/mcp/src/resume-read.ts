import type { RouterClient } from "@orpc/server";
import type router from "@reactive-resume/api/routers";
import { ORPCError } from "@orpc/server";

type ResumeReadInput = { id: string; includeMetadata?: boolean | undefined };

/** Combine owned reads in one tool call without presenting different content revisions as one snapshot. */
export async function readResumeContext(client: RouterClient<typeof router>, input: ResumeReadInput) {
	const [resume, libraryMetadata] = await Promise.all([
		client.resume.getById({ id: input.id }),
		input.includeMetadata ? client.library.resumes.getMetadata({ resumeId: input.id }) : undefined,
	]);
	if (libraryMetadata && resume.updatedAt.getTime() !== libraryMetadata.updatedAt.getTime()) {
		throw new ORPCError("CONFLICT", {
			message: "Resume changed during the combined read. Read it again before editing or reviewing.",
		});
	}
	return { ...resume, ...(libraryMetadata ? { libraryMetadata } : {}) };
}
