import type { LatexProject } from "@reactive-resume/schema/resume/latex";
import { ORPCError } from "@orpc/server";

type CompileSnapshotInput = {
	project?: LatexProject | undefined;
	expectedUpdatedAt?: Date | undefined;
};

/** Select from an already authorized resume read, keeping the source and its version together. */
export function resolveLatexCompileSnapshot(
	resume: { data: { latex?: LatexProject | undefined }; updatedAt: Date },
	input: CompileSnapshotInput,
) {
	if (input.expectedUpdatedAt && input.expectedUpdatedAt.getTime() !== resume.updatedAt.getTime()) {
		throw new ORPCError("RESUME_VERSION_CONFLICT", {
			status: 409,
			message: "The resume changed before this compilation started.",
			data: { updatedAt: resume.updatedAt.toISOString() },
		});
	}

	const project = input.project ?? resume.data.latex;
	if (!project) throw new ORPCError("BAD_REQUEST", { message: "This resume does not contain a LaTeX project." });

	return {
		project,
		// A supplied draft was never read from storage, so it cannot attest to the saved resume's version.
		resumeUpdatedAt: input.project ? null : resume.updatedAt,
	};
}
