import type { ResumeData } from "@reactive-resume/schema/resume/data";
import type { LatexProject } from "@reactive-resume/schema/resume/latex";
import { describe, expect, it } from "vitest";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";
import { compareResumeData } from "./compare";

const latex = (content: string): ResumeData & { latex: LatexProject } => ({
	...structuredClone(defaultResumeData),
	latex: { engine: "pdflatex" as const, entrypoint: "main.tex", files: [{ path: "main.tex", encoding: "utf-8" as const, content }] },
});

describe("saved resume comparison", () => {
	it("reports actual source additions/removals and their line numbers", () => {
		const result = compareResumeData(latex("Header\nOld achievement\nFooter"), latex("Header\nNew achievement\nFooter"));
		expect(result.comparison).toBe("latex");
		expect(result.identical).toBe(false);
		expect(result.files[0]?.lines).toEqual([
			{ kind: "context", text: "Header", oldLine: 1, newLine: 1 },
			{ kind: "removed", text: "Old achievement", oldLine: 2, newLine: null },
			{ kind: "added", text: "New achievement", oldLine: null, newLine: 2 },
			{ kind: "context", text: "Footer", oldLine: 3, newLine: 3 },
		]);
	});

	it("does not confuse reordered JSON keys or workflow notes with printed changes", () => {
		const before = structuredClone(defaultResumeData);
		const after = structuredClone(before);
		after.metadata.notes = "Private tailoring notes";
		after.basics = Object.fromEntries(Object.entries(after.basics).reverse()) as typeof after.basics;
		expect(compareResumeData(before, after).identical).toBe(true);
		after.basics.headline = "Robotics engineer";
		expect(compareResumeData(before, after).files[0]?.path).toBe("resume.json");
	});

	it("marks binary additions without returning base64 payloads", () => {
		const before = latex("Resume");
		const after = latex("Resume");
		after.latex.files.push({ path: "portrait.png", encoding: "base64", content: "aW1hZ2U=" });
		expect(compareResumeData(before, after).files).toEqual([
			{ path: "latex/portrait.png", kind: "added", binary: true, addedLines: 0, removedLines: 0, coarse: false, truncated: false, lines: [] },
		]);
	});

	it("bounds expensive edits and reports complete replacement counts", () => {
		const result = compareResumeData(latex(Array(30_000).fill("old").join("\n")), latex(Array(30_000).fill("new").join("\n")));
		expect(result.truncated).toBe(true);
		expect(result.files[0]?.coarse).toBe(true);
		expect(result.files[0]?.removedLines).toBe(30_000);
		expect(result.files[0]?.addedLines).toBe(30_000);
		expect(result.files[0]?.lines.length).toBeLessThanOrEqual(600);
	});

	it("bounds long lines across the whole response and flags omitted text", () => {
		const result = compareResumeData(latex("before"), latex("after".repeat(100_000)));
		expect(result.truncated).toBe(true);
		expect(result.files.flatMap((file) => file.lines).every((line) => line.text.length <= 4_000)).toBe(true);
	});

	it("tracks entrypoint changes even when file contents stay the same", () => {
		const before = latex("Text");
		const after = latex("Text");
		after.latex.entrypoint = "alternate.tex";
		expect(compareResumeData(before, after).files[0]?.path).toBe("latex/project.json");
	});
});
