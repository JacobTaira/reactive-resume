import type { DocumentSummary } from "./filter";
import type { ResumeDetailsValues } from "./resume-details";
import { describe, expect, it } from "vitest";
import { changedResumeDetails } from "./resume-details";

const profile = {
	purpose: "tailored" as const,
	company: "Example Robotics",
	targetRole: "Robotics Engineer",
	keywords: ["ROS 2", "Python"],
	jobDescription: "Build robots.",
	jobUrl: "https://example.com/job",
	reuseNotes: "Focus on planning.",
	score: 82,
	scoreNotes: "More deployment evidence needed.",
	rubric: [],
	evaluatedAt: "2026-10-01T12:00:00.000Z",
	evaluatedResumeUpdatedAt: "2026-10-01T12:00:00.000Z",
};
const document = {
	id: "tailored",
	profile,
	folderId: "old-folder",
	sourceResumeId: "trashed-master",
	companyId: "company",
} as DocumentSummary;
const values: ResumeDetailsValues = {
	...profile,
	score: "82",
	folderId: "old-folder",
	sourceResumeId: "trashed-master",
	companyId: "company",
};

describe("changedResumeDetails", () => {
	it("moves a resume without renewing its assessment or touching an unavailable source", () => {
		expect(changedResumeDetails(document, { ...values, folderId: "new-folder" })).toEqual({
			resumeId: "tailored",
			folderId: "new-folder",
		});
	});

	it("updates the score only when the assessment changes", () => {
		expect(changedResumeDetails(document, { ...values, scoreNotes: "Reviewed deployment evidence." })).toEqual({
			resumeId: "tailored",
			profile: { score: 82, scoreNotes: "Reviewed deployment evidence." },
		});
	});

	it("sends explicit null to clear a folder, lineage, company, or score", () => {
		expect(changedResumeDetails(document, { ...values, folderId: "", sourceResumeId: "", companyId: "", score: "" })).toEqual({
			resumeId: "tailored",
			folderId: null,
			sourceResumeId: null,
			companyId: null,
			profile: { score: null, scoreNotes: profile.scoreNotes },
		});
	});

	it("trims user text and preserves all untouched metadata", () => {
		expect(changedResumeDetails(document, { ...values, company: "  Example Robotics  ", targetRole: "Staff Engineer" })).toEqual({
			resumeId: "tailored",
			profile: { targetRole: "Staff Engineer" },
		});
	});
});
