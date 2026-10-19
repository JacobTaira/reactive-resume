import type { ResumeIndexEntry } from "../../dto/library";
import { describe, expect, it } from "vitest";
import { assertCurrentSnapshot, assertFolderParent, companyKey, evaluationStale, rankResume, resolveResumeOutcome, reviewFreshness } from "./policy";

describe("resume folder hierarchy", () => {
	const folders = [{ id: "root", parentId: null }, { id: "child", parentId: "root" }, { id: "leaf", parentId: "child" }];
	it("rejects self, descendant, and unowned parents", () => {
		expect(() => assertFolderParent(folders, "root", "root")).toThrow();
		expect(() => assertFolderParent(folders, "root", "leaf")).toThrow();
		expect(() => assertFolderParent(folders, "child", "other-user-folder")).toThrow();
		expect(() => assertFolderParent(folders, "leaf", null)).not.toThrow();
	});
	it("accounts for all descendants when moving a subtree under a deep parent", () => {
		const deep = Array.from({ length: 19 }, (_, index) => ({ id: `f${index}`, parentId: index === 0 ? null : `f${index - 1}` }));
		expect(() => assertFolderParent([...deep, ...folders], "root", "f18")).toThrow();
		expect(() => assertFolderParent(deep, null, "f18")).not.toThrow();
		expect(() => assertFolderParent([...deep, { id: "f19", parentId: "f18" }], null, "f19")).toThrow();
	});
});

const entry: Omit<ResumeIndexEntry, "similarity" | "reusePriority" | "reuseHints"> = {
	id: "resume", name: "Robotics Engineer", folderId: null, sourceResumeId: null, sourceUpdatedAt: null,
	companyId: null, company: "Orbital", targetRole: "Robotics Engineer", purpose: "tailored", keywords: ["ROS 2", "Python"],
	tags: ["robotics"], reuseNotes: "Navigation and controls emphasis", score: 87, evaluatedAt: "2026-10-18T10:00:00Z",
	evaluationStale: false, updatedAt: new Date("2026-10-18T09:00:00Z"), application: null,
	reviewStale: false, sourceStale: false,
	outcome: { stage: "not_applied", recordedAt: null, strongestStage: "not_applied", source: "none" },
};

describe("compact lexical resume index", () => {
	it("normalizes company identity and ranks shared skills without calling an AI provider", () => {
		expect(companyKey("  Ｏｒｂｉｔａｌ  Labs ")).toBe("orbital labs");
		const ranked = rankResume(entry, { company: "orbital", targetRole: "Robotics Engineer", keywords: ["Python", "ROS 2"] });
		expect(ranked.similarity).toBe(100);
		expect(ranked.reuseHints.join(" ")).toContain("Same company");
		expect(rankResume(entry, { company: "Unrelated", targetRole: "Accountant", keywords: ["payroll"] }).similarity).toBe(0);
	});
	it("uses a small recorded-outcome preference only for relevant resume content", () => {
		const offer = { ...entry, outcome: { stage: "offer", strongestStage: "offer", recordedAt: "2026-10-18T10:00:00Z", source: "profile" } as const };
		const ranked = rankResume(offer, { targetRole: "Senior Robotics Engineer", keywords: ["Python", "unmet"] });
		expect(ranked.reusePriority - ranked.similarity).toBe(8);
		expect(ranked.reuseHints.join(" ")).toContain("does not prove");
		expect(rankResume(offer, { company: "Orbital", targetRole: "Accountant" }).reusePriority).toBe(50);
		expect(rankResume(offer, { targetRole: "Accountant" }).reusePriority).toBe(0);
		expect(rankResume(offer, {}).reusePriority).toBe(0);
		const broad = rankResume(offer, { targetRole: "Civil Engineer" });
		expect(broad.similarity).toBe(50);
		expect(broad.reusePriority).toBe(50);
	});
	it("keeps similarity unchanged and caps outcome preference at 100", () => {
		const interview = { ...entry, outcome: { stage: "interview", strongestStage: "interview", recordedAt: "2026-10-18T10:00:00Z", source: "profile" } as const };
		const ranked = rankResume(interview, { targetRole: "Robotics Engineer" });
		expect(ranked.similarity).toBe(100);
		expect(ranked.reusePriority).toBe(100);
	});
	it("makes stale evaluations and master source material explicit", () => {
		const ranked = rankResume({ ...entry, purpose: "master", sourceResumeId: "base", evaluationStale: true }, {});
		expect(ranked.reuseHints).toHaveLength(3);
		expect(ranked).not.toHaveProperty("jobDescription");
		expect(ranked).not.toHaveProperty("data");
	});
	it("treats an unknown evaluation version as stale", () => {
		expect(evaluationStale({ score: 87, evaluatedResumeUpdatedAt: null }, entry.updatedAt)).toBe(true);
		expect(evaluationStale({ score: 87, evaluatedResumeUpdatedAt: entry.updatedAt.toISOString() }, entry.updatedAt)).toBe(false);
		expect(evaluationStale({ score: null, evaluatedResumeUpdatedAt: null }, entry.updatedAt)).toBe(false);
	});
});

describe("source review freshness", () => {
	const resumeAt = new Date("2026-10-18T10:00:00Z");
	const sourceAt = new Date("2026-10-18T09:00:00Z");
	const reviewed = { reviewedResumeUpdatedAt: resumeAt.toISOString(), reviewedSourceUpdatedAt: sourceAt.toISOString() };
	it("detects newer or unavailable sources without changing score freshness", () => {
		expect(reviewFreshness(reviewed, resumeAt, "source", sourceAt)).toEqual({ reviewStale: false, sourceStale: false });
		expect(reviewFreshness(reviewed, resumeAt, "source", new Date("2026-10-18T09:30:00Z"))).toEqual({ reviewStale: true, sourceStale: true });
		expect(reviewFreshness(reviewed, resumeAt, "source", null)).toEqual({ reviewStale: true, sourceStale: true });
		expect(reviewFreshness({ ...reviewed, reviewedSourceUpdatedAt: null }, resumeAt, "source", sourceAt).sourceStale).toBe(true);
		expect(evaluationStale({ score: 90, evaluatedResumeUpdatedAt: resumeAt.toISOString() }, resumeAt)).toBe(false);
	});
	it("allows explicit clearing but rejects stale or invented snapshot dates", () => {
		expect(() => assertCurrentSnapshot(resumeAt.toISOString(), resumeAt, "Resume")).not.toThrow();
		expect(() => assertCurrentSnapshot(null, resumeAt, "Resume")).not.toThrow();
		expect(() => assertCurrentSnapshot(sourceAt.toISOString(), resumeAt, "Resume")).toThrow();
		expect(() => assertCurrentSnapshot(resumeAt.toISOString(), null, "Source")).toThrow();
	});
});

describe("recorded outcome provenance", () => {
	const unrecorded = { stage: "not_applied", notes: "", recordedAt: null, reachedStage: "not_applied" } as const;
	const application = { resumeId: "resume", status: "closed", closedReason: "not-selected", sentResumeVersionId: "version", sentResumeId: "resume", updatedAt: new Date("2026-10-18T10:00:00Z"), activityStages: ["applied", "interview"] };
	it("retains a reached interview alongside its eventual rejection", () => {
		expect(resolveResumeOutcome("resume", unrecorded, application)).toMatchObject({ stage: "rejected", strongestStage: "interview", source: "application" });
	});
	it("does not borrow outcomes from a merely linked job or another submitted resume", () => {
		expect(resolveResumeOutcome("resume", unrecorded, { ...application, resumeId: "other" }).strongestStage).toBe("not_applied");
		expect(resolveResumeOutcome("resume", unrecorded, { ...application, sentResumeId: "other" }).strongestStage).toBe("not_applied");
		expect(resolveResumeOutcome("resume", unrecorded, { ...application, sentResumeVersionId: null }).strongestStage).toBe("not_applied");
		expect(resolveResumeOutcome("resume", unrecorded, { ...application, status: "offer", closedReason: null, sentResumeVersionId: null }).strongestStage).toBe("not_applied");
		expect(resolveResumeOutcome("resume", unrecorded, { ...application, status: "interview", closedReason: null, sentResumeVersionId: null }).strongestStage).toBe("not_applied");
	});
	it("preserves explicit recorded outcome history across terminal stages", () => {
		const profile = { ...unrecorded, stage: "rejected", reachedStage: "interview", recordedAt: "2026-10-18T10:00:00Z" } as const;
		expect(resolveResumeOutcome("resume", profile, null)).toEqual({ stage: "rejected", strongestStage: "interview", recordedAt: profile.recordedAt, source: "profile" });
		expect(resolveResumeOutcome("resume", { ...profile, recordedAt: null }, null).strongestStage).toBe("not_applied");
	});
});
