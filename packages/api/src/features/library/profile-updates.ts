import type z from "zod";
import type { libraryDto, ResumeProfile } from "../../dto/library";
import { ORPCError } from "@orpc/client";
import { resumeProfileSchema } from "../../dto/library";
import { assertCurrentSnapshot, outcomeStageWeight, positiveOutcomeStage } from "./policy";

type ProfilePatch = NonNullable<z.infer<typeof libraryDto.resumes.setMetadata.input>["profile"]>;
type ProfileUpdateContext = {
	resumeUpdatedAt: Date;
	sourceUpdatedAt: Date | null;
	companyChanged: boolean;
	sourceChanged: boolean;
	now: Date;
};

/** Metadata does not change document timestamps, so review and score snapshots stay independent. */
export function mergeResumeProfile(current: ResumeProfile, patch: ProfilePatch, context: ProfileUpdateContext) {
	const profile = resumeProfileSchema.parse({
		...current,
		...patch,
		outcome: { ...current.outcome, ...patch.outcome },
	});
	const targetChanged = context.companyChanged ||
		(patch.company !== undefined && patch.company !== current.company) ||
		(patch.targetRole !== undefined && patch.targetRole !== current.targetRole) ||
		(patch.jobDescription !== undefined && patch.jobDescription !== current.jobDescription) ||
		(patch.jobUrl !== undefined && patch.jobUrl !== current.jobUrl) ||
		(patch.keywords !== undefined && JSON.stringify(patch.keywords) !== JSON.stringify(current.keywords));
	const reviewChanged = targetChanged || context.sourceChanged ||
		(patch.requirementEvidence !== undefined && JSON.stringify(patch.requirementEvidence) !== JSON.stringify(current.requirementEvidence)) ||
		(patch.tailoringChanges !== undefined && JSON.stringify(patch.tailoringChanges) !== JSON.stringify(current.tailoringChanges));

	assertCurrentSnapshot(patch.evaluatedResumeUpdatedAt, context.resumeUpdatedAt, "Resume");
	assertCurrentSnapshot(patch.reviewedResumeUpdatedAt, context.resumeUpdatedAt, "Resume");
	assertCurrentSnapshot(patch.reviewedSourceUpdatedAt, context.sourceUpdatedAt, "Source resume");
	if (patch.evaluatedAt && Date.parse(patch.evaluatedAt) > context.now.getTime() + 5 * 60_000) {
		throw new ORPCError("BAD_REQUEST", { message: "An evaluation time cannot be in the future." });
	}
	if (patch.outcome?.recordedAt && Date.parse(patch.outcome.recordedAt) > context.now.getTime() + 5 * 60_000) {
		throw new ORPCError("BAD_REQUEST", { message: "An outcome recording time cannot be in the future." });
	}

	const hasEvaluation = patch.score !== undefined || patch.rubric !== undefined;
	if (hasEvaluation) {
		profile.evaluatedAt = profile.score === null ? null : patch.evaluatedAt ?? context.now.toISOString();
		profile.evaluatedResumeUpdatedAt = profile.score === null ? null : patch.evaluatedResumeUpdatedAt ?? context.resumeUpdatedAt.toISOString();
	} else if (targetChanged) {
		profile.evaluatedAt = null;
		profile.evaluatedResumeUpdatedAt = null;
	}
	if (reviewChanged) {
		profile.reviewedResumeUpdatedAt = patch.reviewedResumeUpdatedAt ?? null;
		profile.reviewedSourceUpdatedAt = patch.reviewedSourceUpdatedAt ?? null;
	}
	if (patch.outcome && (patch.outcome.stage !== undefined || patch.outcome.notes !== undefined || patch.outcome.reachedStage !== undefined)) {
		profile.outcome.recordedAt = patch.outcome.recordedAt ?? context.now.toISOString();
		if (patch.outcome.stage === "not_applied") profile.outcome.reachedStage = "not_applied";
		else if (patch.outcome.reachedStage === undefined) {
			const stages = [current.outcome.reachedStage, positiveOutcomeStage(current.outcome.stage), positiveOutcomeStage(profile.outcome.stage)];
			profile.outcome.reachedStage = stages.reduce((highest, candidate) =>
				outcomeStageWeight[candidate] > outcomeStageWeight[highest] ? candidate : highest, "not_applied");
		}
	}
	return profile;
}
