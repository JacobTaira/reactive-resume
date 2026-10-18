import { describe, expect, it } from "vitest";
import { libraryDto, resumeProfileSchema } from "../../dto/library";

describe("library API contracts", () => {
	it("keeps omitted metadata fields absent in partial patches", () => {
		const { profile } = libraryDto.resumes.setMetadata.input.parse({ resumeId: "resume", profile: { score: 90 } });
		expect(profile).toEqual({ score: 90 });
		expect(resumeProfileSchema.parse({ ...resumeProfileSchema.parse({ purpose: "master", company: "Orbital", keywords: ["ROS"] }), ...profile })).toMatchObject({ purpose: "master", company: "Orbital", keywords: ["ROS"], score: 90 });
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
