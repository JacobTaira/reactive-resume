import { describe, expect, it } from "vitest";
import { buildRelatedResumeQuery, getResumeReviewFreshness, selectRelatedResumes } from "./resume-review";

const updatedAt = new Date("2026-10-18T12:00:00.000Z");
const sourceUpdatedAt = new Date("2026-10-17T12:00:00.000Z");
const profile = {
	reviewedResumeUpdatedAt: updatedAt.toISOString(),
	reviewedSourceUpdatedAt: sourceUpdatedAt.toISOString(),
};

describe("getResumeReviewFreshness", () => {
	it("keeps a review current when both revisions match, including equivalent timezone offsets", () => {
		expect(getResumeReviewFreshness({
			profile: { ...profile, reviewedResumeUpdatedAt: "2026-10-18T07:00:00-05:00" },
			updatedAt,
			sourceResumeId: "master",
			sourceUpdatedAt,
		})).toEqual({ reviewed: true, reviewStale: false, sourceStale: false });
	});

	it("requires another review after the tailored resume changes", () => {
		expect(getResumeReviewFreshness({ profile, updatedAt: new Date(updatedAt.getTime() + 1) })).toEqual({
			reviewed: true,
			reviewStale: true,
			sourceStale: false,
		});
	});

	it("requires another review after the source resume changes", () => {
		expect(getResumeReviewFreshness({
			profile,
			updatedAt,
			sourceResumeId: "master",
			sourceUpdatedAt: new Date(sourceUpdatedAt.getTime() + 1),
		})).toEqual({ reviewed: true, reviewStale: true, sourceStale: true });
	});

	it("does not verify a missing source or a source with no reviewed revision", () => {
		for (const input of [
			{ profile, updatedAt, sourceResumeId: "unavailable-master" },
			{
				profile: { reviewedResumeUpdatedAt: profile.reviewedResumeUpdatedAt },
				updatedAt,
				sourceResumeId: "master",
				sourceUpdatedAt,
			},
		]) {
			expect(getResumeReviewFreshness(input)).toEqual({ reviewed: true, reviewStale: true, sourceStale: true });
		}
	});

	it("does not treat absent review metadata as a completed review", () => {
		expect(getResumeReviewFreshness({ updatedAt })).toEqual({
			reviewed: false,
			reviewStale: true,
			sourceStale: false,
		});
	});

	it("does not keep a corrupt revision current", () => {
		const freshness = getResumeReviewFreshness({ profile: { reviewedResumeUpdatedAt: "invalid" }, updatedAt });
		expect(freshness.reviewStale).toBe(true);
	});
});

describe("buildRelatedResumeQuery", () => {
	it("avoids searching for a resume that has no meaningful company, role, or keywords", () => {
		expect(buildRelatedResumeQuery(null)).toBeNull();
		expect(buildRelatedResumeQuery({ company: "  ", targetRole: "\n", keywords: ["", " \t"] })).toBeNull();
	});

	it("trims target fields and deduplicates keywords without changing their spelling", () => {
		expect(buildRelatedResumeQuery({
			company: "  Example Robotics ",
			targetRole: " Robotics Engineer ",
			keywords: [" C++ ", "c++", "ROS 2", "", " ros 2 "],
		})).toEqual({ company: "Example Robotics", targetRole: "Robotics Engineer", keywords: ["C++", "ROS 2"], limit: 30 });
	});

	it("omits empty fields from a skills-only search", () => {
		expect(buildRelatedResumeQuery({ keywords: ["Python"] })).toEqual({ keywords: ["Python"], limit: 30 });
	});
});

describe("selectRelatedResumes", () => {
	it("excludes itself and unrelated resumes even when an outcome gives them high priority", () => {
		const entries = [
			{ id: "self", similarity: 100, reusePriority: 100 },
			{ id: "unrelated", similarity: 0, reusePriority: 100 },
			{ id: "related", similarity: 40, reusePriority: 55 },
		];
		expect(selectRelatedResumes(entries, "self").map((entry) => entry.id)).toEqual(["related"]);
	});

	it("orders by reusable outcome priority then lexical similarity without reordering the index", () => {
		const entries = [
			{ id: "less-related", similarity: 50, reusePriority: 70 },
			{ id: "priority", similarity: 45, reusePriority: 85 },
			{ id: "more-related", similarity: 70, reusePriority: 70 },
		];
		expect(selectRelatedResumes(entries, "self").map((entry) => entry.id)).toEqual([
			"priority", "more-related", "less-related",
		]);
		expect(entries.map((entry) => entry.id)).toEqual(["less-related", "priority", "more-related"]);
	});

	it("keeps suggestions bounded to five resumes", () => {
		const entries = Array.from({ length: 8 }, (_, index) => ({
			id: String(index), similarity: 80, reusePriority: 80,
		}));
		expect(selectRelatedResumes(entries, "self", 100)).toHaveLength(5);
		expect(selectRelatedResumes(entries, "self", 2)).toHaveLength(2);
		expect(selectRelatedResumes(entries, "self", -1)).toHaveLength(0);
	});
});
