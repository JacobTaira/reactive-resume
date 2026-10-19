import type { LatexProject } from "@reactive-resume/schema/resume/latex";
import { describe, expect, it } from "vitest";
import { resolveLatexCompileSnapshot } from "./compile-snapshot";

const project: LatexProject = {
	engine: "pdflatex",
	entrypoint: "main.tex",
	files: [{ path: "main.tex", encoding: "utf-8", content: "Saved source" }],
};
const updatedAt = new Date("2026-10-19T07:00:00.123Z");
const resume = { data: { latex: project }, updatedAt };

describe("LaTeX compilation snapshot", () => {
	it("returns the saved source and its version from the same read", () => {
		const snapshot = resolveLatexCompileSnapshot(resume, {});
		expect(snapshot.project).toBe(project);
		expect(snapshot.resumeUpdatedAt).toBe(updatedAt);
	});

	it("accepts an equivalent expected timestamp at JavaScript millisecond precision", () => {
		const snapshot = resolveLatexCompileSnapshot(resume, { expectedUpdatedAt: new Date(updatedAt.toISOString()) });
		expect(snapshot.resumeUpdatedAt).toBe(updatedAt);
	});

	it("rejects stale saved-source compilation before handing a project to the worker", () => {
		expect(() => resolveLatexCompileSnapshot(resume, { expectedUpdatedAt: new Date(updatedAt.getTime() - 1) }))
			.toThrow(expect.objectContaining({
				code: "RESUME_VERSION_CONFLICT",
				status: 409,
				data: { updatedAt: updatedAt.toISOString() },
			}));
	});

	it("never labels a supplied draft as the stored resume, even when its source is identical", () => {
		const snapshot = resolveLatexCompileSnapshot(resume, { project, expectedUpdatedAt: updatedAt });
		expect(snapshot.project).toBe(project);
		expect(snapshot.resumeUpdatedAt).toBeNull();
	});

	it("still checks the expected version for a supplied draft", () => {
		expect(() => resolveLatexCompileSnapshot(resume, {
			project,
			expectedUpdatedAt: new Date(updatedAt.getTime() + 1),
		})).toThrow(expect.objectContaining({ code: "RESUME_VERSION_CONFLICT", status: 409 }));
	});

	it("permits an authorized supplied project when the saved resume has no LaTeX source", () => {
		const snapshot = resolveLatexCompileSnapshot({ data: {}, updatedAt }, { project });
		expect(snapshot.project).toBe(project);
		expect(snapshot.resumeUpdatedAt).toBeNull();
	});

	it("rejects a saved resume without LaTeX source", () => {
		expect(() => resolveLatexCompileSnapshot({ data: {}, updatedAt }, {}))
			.toThrow(expect.objectContaining({ code: "BAD_REQUEST" }));
	});
});
