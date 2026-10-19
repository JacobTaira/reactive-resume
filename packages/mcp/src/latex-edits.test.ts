import { describe, expect, it } from "vitest";
import type { LatexProject } from "@reactive-resume/schema/resume/latex";
import { applyLatexTextEdits, assertLatexFormattingPreserved, latexTextEditsSchema } from "./latex-edits";

const source = String.raw`\documentclass[10pt]{article}
\usepackage{titlesec}
\newcommand{\resumeItem}[1]{\item #1}
\titleformat{\section}{\bfseries}{}{0pt}{}
% An inactive example: \begin{document}
\begin{document}
\begin{center}
Candidate Name
\end{center}
\section{Experience}
\resumeItem{Built a sensor pipeline.}
\resumeItem{Reviewed test results.}
\input{sections/projects.tex}
\end{document}
`;

function project(content = source): LatexProject {
	return {
		engine: "pdflatex", entrypoint: "main.tex", files: [
			{ path: "main.tex", encoding: "utf-8", content },
			{ path: "sections/projects.tex", encoding: "utf-8", content: String.raw`\resumeItem{Documented system interfaces.}` },
			{ path: "template.sty", encoding: "utf-8", content: String.raw`\newcommand{\sample}{Style}` },
			{ path: "image.png", encoding: "base64", content: "YWJj" },
		],
	};
}

function replaceBody(oldText: string, newText: string, allowFormattingChanges = false) {
	return { edits: [{ path: "main.tex", oldText, newText }], allowFormattingChanges };
}

describe("exact LaTeX source edits", () => {
	it("replaces several bullets in one call while preserving every other byte and supporting file", () => {
		const before = project();
		const snapshot = JSON.stringify(before);
		const result = applyLatexTextEdits(before, { edits: [
			{ path: "main.tex", oldText: "Built a sensor pipeline.", newText: "Implemented a sensor-processing pipeline." },
			{ path: "main.tex", oldText: "Reviewed test results.", newText: "Analyzed integration-test results." },
		] });
		expect(result.project.files[0]!.content).toBe(source.replace("Built a sensor pipeline.", "Implemented a sensor-processing pipeline.").replace("Reviewed test results.", "Analyzed integration-test results."));
		expect(result.project.files.slice(1)).toEqual(before.files.slice(1));
		expect(JSON.stringify(before)).toBe(snapshot);
		expect(result.changedFiles).toEqual(["main.tex"]);
		expect(result.appliedEdits).toBe(2);
	});

	it("edits included content files without requiring a whole-file rewrite", () => {
		const result = applyLatexTextEdits(project(), { edits: [{ path: "sections/projects.tex", oldText: "Documented system interfaces.", newText: "Documented typed system interfaces." }] });
		expect(result.project.files[1]!.content).toBe(String.raw`\resumeItem{Documented typed system interfaces.}`);
	});

	it("resolves all edits against the original snapshot even when replacements change text length", () => {
		const before = project(source.replace("Built a sensor pipeline.", "Alpha Beta Gamma"));
		const result = applyLatexTextEdits(before, { edits: [
			{ path: "main.tex", oldText: "Alpha", newText: "Beta Beta Beta" },
			{ path: "main.tex", oldText: "Beta", newText: "Delta" },
		] });
		expect(result.project.files[0]!.content).toContain("Beta Beta Beta Delta Gamma");
	});

	it("supports adjacent replacements and deletion of a bullet", () => {
		const before = project(source.replace("Built a sensor pipeline.", "AlphaBeta"));
		const result = applyLatexTextEdits(before, { edits: [
			{ path: "main.tex", oldText: "Alpha", newText: "One" },
			{ path: "main.tex", oldText: "Beta", newText: "Two" },
			{ path: "main.tex", oldText: String.raw`\resumeItem{Reviewed test results.}`, newText: "" },
		] });
		expect(result.project.files[0]!.content).toContain("OneTwo");
		expect(result.project.files[0]!.content.includes("Reviewed test results.")).toBe(false);
	});

	it("rejects missing or ambiguous matches, including overlapping occurrences of a search string", () => {
		expect(() => applyLatexTextEdits(project(), replaceBody("Not present", "New text"))).toThrow();
		expect(() => applyLatexTextEdits(project(), replaceBody("resumeItem", "newItem"))).toThrow();
		expect(() => applyLatexTextEdits(project(source.replace("Candidate Name", "AAA")), replaceBody("AA", "BB"))).toThrow();
	});

	it("rejects overlapping replacements atomically without mutating the original project", () => {
		const before = project();
		const snapshot = JSON.stringify(before);
		expect(() => applyLatexTextEdits(before, { edits: [
			{ path: "main.tex", oldText: "Built a sensor pipeline.", newText: "Updated bullet." },
			{ path: "main.tex", oldText: "sensor pipeline", newText: "data processing" },
		] })).toThrow();
		expect(JSON.stringify(before)).toBe(snapshot);
	});

	it("rejects invalid later edits without applying earlier valid edits", () => {
		const before = project();
		const snapshot = JSON.stringify(before);
		expect(() => applyLatexTextEdits(before, { edits: [
			{ path: "main.tex", oldText: "Candidate Name", newText: "Updated Name" },
			{ path: "main.tex", oldText: "Missing source", newText: "New text" },
		] })).toThrow();
		expect(JSON.stringify(before)).toBe(snapshot);
	});

	it("rejects unknown paths, binary assets, stylesheets and no-op replacements", () => {
		for (const path of ["missing.tex", "image.png", "template.sty"]) {
			expect(() => applyLatexTextEdits(project(), { edits: [{ path, oldText: "Style", newText: "Other" }] })).toThrow();
		}
		expect(() => applyLatexTextEdits(project(), replaceBody("Candidate Name", "Candidate Name"))).toThrow();
	});

	it("validates nonempty, bounded edits and safe paths before applying any change", () => {
		expect(latexTextEditsSchema.safeParse({ edits: [] }).success).toBe(false);
		expect(latexTextEditsSchema.safeParse({ edits: [{ path: "../main.tex", oldText: "old", newText: "new" }] }).success).toBe(false);
		expect(latexTextEditsSchema.safeParse(replaceBody("", "new")).success).toBe(false);
		expect(latexTextEditsSchema.safeParse(replaceBody("old", "n".repeat(20_001))).success).toBe(false);
		expect(latexTextEditsSchema.safeParse({ ...replaceBody("old", "new"), unexpected: true }).success).toBe(false);
	});
});

describe("LaTeX design preservation", () => {
	it("rejects preamble changes and document boundary deletion by default", () => {
		expect(() => applyLatexTextEdits(project(), replaceBody("[10pt]", "[9pt]"))).toThrow();
		expect(() => applyLatexTextEdits(project(), replaceBody(String.raw`\end{document}`, ""))).toThrow();
		expect(() => applyLatexTextEdits(project(), replaceBody("Candidate Name", String.raw`\begin{document} Candidate Name`))).toThrow();
	});

	it("rejects alignment and layout insertions into body text or included files", () => {
		for (const command of [String.raw`\raggedright`, String.raw`\centering`, String.raw`\geometry{margin=0.1in}`, String.raw`\titleformat{\section}{\tiny}{}{0pt}{}`]) {
			expect(() => applyLatexTextEdits(project(), replaceBody("Candidate Name", `${command} Candidate Name`))).toThrow();
			expect(() => applyLatexTextEdits(project(), { edits: [{ path: "sections/projects.tex", oldText: "Documented system interfaces.", newText: `${command} Documented system interfaces.` }] })).toThrow();
		}
	});

	it("rejects added or removed centering environments", () => {
		expect(() => applyLatexTextEdits(project(), replaceBody(String.raw`\begin{center}`, String.raw`\begin{center}\begin{center}`))).toThrow();
		expect(() => applyLatexTextEdits(project(), replaceBody(String.raw`\end{center}`, ""))).toThrow();
	});

	it("allows supported text emphasis and escaped literal commands without mistaking them for layout changes", () => {
		const result = applyLatexTextEdits(project(), replaceBody("Built a sensor pipeline.", String.raw`Built a \textbf{sensor} pipeline with 90\% verified coverage.`));
		expect(result.project.files[0]!.content).toContain(String.raw`\textbf{sensor}`);
		expect(() => applyLatexTextEdits(project(), replaceBody("Candidate Name", String.raw`Candidate Name % \raggedright`))).not.toThrow();
	});

	it("permits an explicit formatting-change opt-in", () => {
		const result = applyLatexTextEdits(project(), replaceBody("[10pt]", "[11pt]", true));
		expect(result.project.files[0]!.content).toContain("[11pt]");
	});

	it("checks template changes from existing full-file patch paths too", () => {
		const before = project();
		expect(() => assertLatexFormattingPreserved(before, project(source.replace("Built a sensor pipeline.", "Built a verified sensor pipeline.")))).not.toThrow();
		expect(() => assertLatexFormattingPreserved(before, project(source.replace("Candidate Name", String.raw`\raggedright Candidate Name`)))).toThrow();
		const assetsChanged = project();
		assetsChanged.files[3]!.content = "ZGVm";
		expect(() => assertLatexFormattingPreserved(before, assetsChanged)).toThrow();
	});
});
