import type { ResumeIndexEntry } from "../../dto/library";
import { describe, expect, it } from "vitest";
import { assertFolderParent, companyKey, evaluationStale, rankResume } from "./policy";

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

const entry: Omit<ResumeIndexEntry, "similarity" | "reuseHints"> = {
	id: "resume", name: "Robotics Engineer", folderId: null, sourceResumeId: null, sourceUpdatedAt: null,
	companyId: null, company: "Orbital", targetRole: "Robotics Engineer", purpose: "tailored", keywords: ["ROS 2", "Python"],
	tags: ["robotics"], reuseNotes: "Navigation and controls emphasis", score: 87, evaluatedAt: "2026-10-18T10:00:00Z",
	evaluationStale: false, updatedAt: new Date("2026-10-18T09:00:00Z"), application: null,
};

describe("compact lexical resume index", () => {
	it("normalizes company identity and ranks shared skills without calling an AI provider", () => {
		expect(companyKey("  Ｏｒｂｉｔａｌ  Labs ")).toBe("orbital labs");
		const ranked = rankResume(entry, { company: "orbital", targetRole: "Robotics Engineer", keywords: ["Python", "ROS 2"] });
		expect(ranked.similarity).toBe(100);
		expect(ranked.reuseHints.join(" ")).toContain("Same company");
		expect(rankResume(entry, { company: "Unrelated", targetRole: "Accountant", keywords: ["payroll"] }).similarity).toBe(0);
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
