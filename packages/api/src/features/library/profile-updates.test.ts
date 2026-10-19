import { describe, expect, it } from "vitest";
import { resumeProfileSchema } from "../../dto/library";
import { mergeResumeProfile } from "./profile-updates";

const resumeAt = new Date("2026-10-18T10:00:00Z");
const sourceAt = new Date("2026-10-18T09:00:00Z");
const now = new Date("2026-10-19T10:00:00Z");
const context = { resumeUpdatedAt: resumeAt, sourceUpdatedAt: sourceAt, companyChanged: false, sourceChanged: false, now };
const current = resumeProfileSchema.parse({
	purpose: "tailored", company: "Orbital", score: 90,
	evaluatedAt: resumeAt.toISOString(), evaluatedResumeUpdatedAt: resumeAt.toISOString(),
	reviewedResumeUpdatedAt: resumeAt.toISOString(), reviewedSourceUpdatedAt: sourceAt.toISOString(),
	outcome: { stage: "interview", notes: "Technical interview", recordedAt: resumeAt.toISOString() },
});

describe("resume review and outcome metadata updates", () => {
	it("preserves omitted outcome fields and the strongest reached stage after rejection", () => {
		const changed = mergeResumeProfile(current, { outcome: { stage: "rejected" } }, context);
		expect(changed.outcome).toEqual({ stage: "rejected", notes: "Technical interview", recordedAt: now.toISOString(), reachedStage: "interview" });
		expect(changed.reviewedResumeUpdatedAt).toBe(current.reviewedResumeUpdatedAt);
		expect(changed.evaluatedResumeUpdatedAt).toBe(current.evaluatedResumeUpdatedAt);
		const correction = mergeResumeProfile(changed, { outcome: { stage: "not_applied" } }, context);
		expect(correction.outcome.reachedStage).toBe("not_applied");
	});
	it("invalidates review and score on a new job while outcome-only edits refresh neither", () => {
		const changed = mergeResumeProfile(current, { targetRole: "Controls Engineer" }, context);
		expect(changed).toMatchObject({ reviewedResumeUpdatedAt: null, reviewedSourceUpdatedAt: null, evaluatedResumeUpdatedAt: null, score: 90 });
		const outcome = mergeResumeProfile(current, { outcome: { notes: "Awaiting recruiter feedback" } }, context);
		expect(outcome.reviewedSourceUpdatedAt).toBe(current.reviewedSourceUpdatedAt);
		expect(outcome.evaluatedAt).toBe(current.evaluatedAt);
	});
	it("checks assistant snapshots against current documents rather than certifying old readings", () => {
		expect(() => mergeResumeProfile(current, { score: 95, evaluatedResumeUpdatedAt: sourceAt.toISOString() }, context)).toThrow();
		expect(() => mergeResumeProfile(current, { reviewedResumeUpdatedAt: sourceAt.toISOString() }, context)).toThrow();
		expect(() => mergeResumeProfile(current, { reviewedSourceUpdatedAt: resumeAt.toISOString() }, context)).toThrow();
		expect(() => mergeResumeProfile(current, { reviewedSourceUpdatedAt: sourceAt.toISOString() }, { ...context, sourceUpdatedAt: null })).toThrow();
	});
	it("accepts a completed current review and keeps it separate from score freshness", () => {
		const reviewed = mergeResumeProfile(current, {
			targetRole: "Controls Engineer", reviewedResumeUpdatedAt: resumeAt.toISOString(), reviewedSourceUpdatedAt: sourceAt.toISOString(),
		}, context);
		expect(reviewed.reviewedResumeUpdatedAt).toBe(resumeAt.toISOString());
		expect(reviewed.reviewedSourceUpdatedAt).toBe(sourceAt.toISOString());
		expect(reviewed.evaluatedResumeUpdatedAt).toBeNull();
		const rescored = mergeResumeProfile({ ...current, reviewedResumeUpdatedAt: null }, { score: 94 }, context);
		expect(rescored.evaluatedResumeUpdatedAt).toBe(resumeAt.toISOString());
		expect(rescored.reviewedResumeUpdatedAt).toBeNull();
	});
	it("clears review when evidence, change notes, or the source changes without a new review", () => {
		const evidence = mergeResumeProfile(current, { requirementEvidence: [{ requirement: "C++", importance: "required", status: "gap", evidence: [], notes: "Ask for evidence" }] }, context);
		expect(evidence.reviewedResumeUpdatedAt).toBeNull();
		expect(evidence.evaluatedResumeUpdatedAt).toBe(current.evaluatedResumeUpdatedAt);
		expect(mergeResumeProfile(current, {}, { ...context, sourceChanged: true }).reviewedSourceUpdatedAt).toBeNull();
	});
	it("rejects future recording dates", () => {
		expect(() => mergeResumeProfile(current, { outcome: { recordedAt: "2099-01-01T00:00:00Z" } }, context)).toThrow();
		expect(() => mergeResumeProfile(current, { score: 94, evaluatedAt: "2099-01-01T00:00:00Z" }, context)).toThrow();
	});
});
