import { describe, expect, it } from "vitest";
import { libraryDto, resumeProfileSchema } from "../../dto/library";

describe("library API contracts", () => {
	it("keeps omitted metadata fields absent in partial patches", () => {
		const { profile } = libraryDto.resumes.setMetadata.input.parse({ resumeId: "resume", profile: { score: 90 } });
		expect(profile).toEqual({ score: 90 });
		expect(resumeProfileSchema.parse({ ...resumeProfileSchema.parse({ purpose: "master", company: "Orbital", keywords: ["ROS"] }), ...profile })).toMatchObject({ purpose: "master", company: "Orbital", keywords: ["ROS"], score: 90 });
	});
	it("defaults the new review fields and keeps sparse nested outcome patches sparse", () => {
		expect(resumeProfileSchema.parse({})).toMatchObject({ requirementEvidence: [], tailoringChanges: [], reviewedResumeUpdatedAt: null, reviewedSourceUpdatedAt: null, outcome: { stage: "not_applied", notes: "", recordedAt: null, reachedStage: "not_applied" } });
		const patch = libraryDto.resumes.setMetadata.input.parse({ resumeId: "resume", profile: { outcome: { notes: "Interview scheduled" } } });
		expect(patch.profile).toEqual({ outcome: { notes: "Interview scheduled" } });
	});
	it("requires cited sources for support claims and bounds evidence and change logs", () => {
		const parse = (profile: unknown) => libraryDto.resumes.setMetadata.input.safeParse({ resumeId: "resume", profile });
		expect(parse({ requirementEvidence: [{ requirement: "ROS 2", status: "supported" }] }).success).toBe(false);
		expect(parse({ requirementEvidence: [{ requirement: "ROS 2", status: "supported", evidence: [{ resumeId: "master", locator: "/latex/files/0/content", quote: "Built a ROS 2 navigation stack" }] }] }).success).toBe(true);
		expect(parse({ requirementEvidence: Array.from({ length: 61 }, () => ({ requirement: "ROS", status: "gap" })) }).success).toBe(false);
		expect(parse({ tailoringChanges: [{ section: "Experience", before: "x".repeat(4_001), after: "", reason: "Clarify evidence" }] }).success).toBe(false);
		expect(parse({ reviewedSourceUpdatedAt: "yesterday" }).success).toBe(false);
	});
	it("requires a read revision before changing or deleting accumulated company research", () => {
		expect(libraryDto.companies.save.input.safeParse({ id: "company", company: "Orbital", notes: "Replacement" }).success).toBe(false);
		expect(libraryDto.companies.save.input.safeParse({ id: "company", company: "Orbital", expectedRevision: 3, notes: "Merged notes" }).success).toBe(true);
		expect(libraryDto.companies.delete.input.safeParse({ id: "company" }).success).toBe(false);
	});
	it("bounds source research, scores, keyword lists, and URL protocols", () => {
		expect(libraryDto.companies.save.input.safeParse({ company: "Orbital", website: "javascript:alert(1)" }).success).toBe(false);
		expect(libraryDto.resumes.setMetadata.input.safeParse({ resumeId: "resume", profile: { rubric: [{ criterion: "Evidence", score: 20, maxScore: 10 }] } }).success).toBe(false);
		expect(libraryDto.resumes.index.input.safeParse({ limit: 1_000 }).success).toBe(false);
		expect(libraryDto.resumes.setMetadata.input.safeParse({ resumeId: "resume", profile: { jobDescription: "x".repeat(30_001) } }).success).toBe(false);
	});
});
