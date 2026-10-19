import { describe, expect, it } from "vitest";
import type { LatexProject } from "@reactive-resume/schema/resume/latex";
import { applyLatexRegionEdits, latexRegionEditsSchema, latexSourceIndex } from "./latex-regions";

const source = String.raw`\documentclass[10pt]{article}
\usepackage{needspace}
\newcommand{\resumeItem}[1]{\item #1}
\begin{document}
\begin{center}
Candidate Name
\end{center}

\needspace{5\baselineskip}
\section{Experience}
\begin{itemize}
\resumeItem{Built a sensor pipeline.}
\resumeItem{Reviewed test results.}
\end{itemize}

\vspace{2pt}
\needspace{5\baselineskip}
\section{Projects}
\begin{itemize}
\resumeItem{Documented system interfaces.}
\end{itemize}

\vspace{2pt}
\needspace{5\baselineskip}
\section{Education}
Verified education facts.
\end{document}
`;

function project(content = source): LatexProject {
	return { engine: "pdflatex", entrypoint: "main.tex", files: [
		{ path: "main.tex", encoding: "utf-8", content },
		{ path: "parts/extra.tex", encoding: "utf-8", content: "Other verified facts.\n" },
		{ path: "template.sty", encoding: "utf-8", content: String.raw`\newcommand{\style}{Style}` },
		{ path: "image.png", encoding: "base64", content: "YWJj" },
	] };
}
const indexOf = (content = source) => latexSourceIndex("main.tex", content, true);
const lineOf = (text: string, content = source) => content.split(/\r\n|\r|\n/).findIndex((line) => line.includes(text)) + 1;
const sectionOf = (title: string, content = source) => {
	const section = indexOf(content).sections.find((entry) => entry.title === title);
	if (!section) throw new Error(`Missing fixture section: ${title}`);
	return section;
};

describe("indexed LaTeX edits", () => {
	it("returns one numbered source, stable section IDs and explicit locked boundaries", () => {
		const index = indexOf();
		expect(index.sections.map((section) => section.title)).toEqual(["Experience", "Projects", "Education"]);
		expect(index.sections).toEqual(indexOf().sections);
		expect(index.numberedSource).toContain("1|\\documentclass[10pt]{article}");
		expect(index.editableRange!.startLine).toBe(sectionOf("Experience").startLine);
		expect(index.editableRange!.endLine).toBe(lineOf("\\end{document}") - 1);
		expect(index.editableRange!.startLine > lineOf("Candidate Name")).toBe(true);
	});

	it("removes a complete section and its leading space reservation without oldText or empty placeholders", () => {
		const before = project();
		const snapshot = JSON.stringify(before);
		const section = sectionOf("Projects");
		const result = applyLatexRegionEdits(before, { sectionEdits: [{ path: "main.tex", sectionId: section.id }] });
		const content = result.project.files[0]!.content;
		expect(content.includes("Documented system interfaces.")).toBe(false);
		expect(content.includes("\\section{Projects}")).toBe(false);
		expect(content.match(/\\needspace\{/g)).toHaveLength(2);
		expect(content).toContain("\\section{Experience}");
		expect(content).toContain("\\section{Education}");
		expect(content.slice(0, content.indexOf("\\section{Experience}"))).toBe(source.slice(0, source.indexOf("\\section{Experience}")));
		expect(result.project.files.slice(1)).toEqual(before.files.slice(1));
		expect(JSON.stringify(before)).toBe(snapshot);
	});

	it("deletes a large unwanted section with a bounded ID payload instead of echoing its contents", () => {
		const content = source.replace("Documented system interfaces.", "Verified background. ".repeat(800));
		const request = { sectionEdits: [{ path: "main.tex", sectionId: sectionOf("Projects", content).id }] };
		expect(JSON.stringify(request).length).toBeLessThan(150);
		const result = applyLatexRegionEdits(project(content), request);
		expect(result.project.files[0]!.content.includes("Verified background.")).toBe(false);
	});
	it("removes a section's explicit page break instead of leaving an empty page", () => {
		for (const command of ["\\newpage", "\\clearpage", "\\pagebreak[4]"]) {
			const content = source.replace("\\section{Projects}", `${command}\n\\section{Projects}`);
			const result = applyLatexRegionEdits(project(content), { sectionEdits: [{ path: "main.tex", sectionId: sectionOf("Projects", content).id }] });
			expect(result.project.files[0]!.content.includes(command)).toBe(false);
			expect(result.project.files[0]!.content.includes("\\section{Projects}")).toBe(false);
		}
	});

	it("replaces a section with final text only while preserving document and template bytes", () => {
		const newText = "\\section{Projects}\nVerified concise project.\n";
		const result = applyLatexRegionEdits(project(), { sectionEdits: [{ path: "main.tex", sectionId: sectionOf("Projects").id, newText }] });
		expect(result.project.files[0]!.content).toContain(newText);
		expect(result.project.files[0]!.content).toContain("\\documentclass[10pt]{article}");
		expect(result.project.files[0]!.content).toContain("Candidate Name");
		expect(result.project.files[0]!.content.endsWith("\\end{document}\n")).toBe(true);
	});

	it("resolves line edits and section removals against one original snapshot", () => {
		const line = lineOf("Built a sensor pipeline.");
		const result = applyLatexRegionEdits(project(), {
			sectionEdits: [{ path: "main.tex", sectionId: sectionOf("Projects").id }],
			lineEdits: [{ path: "main.tex", startLine: line, endLine: line, newText: "\\resumeItem{Implemented a verified sensor pipeline.}" }],
		});
		expect(result.appliedEdits).toBe(2);
		expect(result.project.files[0]!.content).toContain("Implemented a verified sensor pipeline.");
		expect(result.project.files[0]!.content.includes("\\section{Projects}")).toBe(false);
	});

	it("preserves CRLF bytes outside replacements and supports included fragments", () => {
		const original = source.replaceAll("\n", "\r\n");
		const line = lineOf("Built a sensor pipeline.", original);
		const result = applyLatexRegionEdits(project(original), { lineEdits: [
			{ path: "main.tex", startLine: line, endLine: line, newText: "\\resumeItem{Implemented a verified sensor pipeline.}" },
			{ path: "parts/extra.tex", startLine: 1, endLine: 1, newText: "Other supported facts." },
		] });
		expect(result.project.files[0]!.content).toBe(original.replace("Built a sensor pipeline.", "Implemented a verified sensor pipeline."));
		expect(result.project.files[1]!.content).toBe("Other supported facts.\n");
	});

	it("allows adjacent section removals without leaving empty needspace directives", () => {
		const result = applyLatexRegionEdits(project(), { sectionEdits: ["Projects", "Education"].map((title) => ({ path: "main.tex", sectionId: sectionOf(title).id })) });
		const content = result.project.files[0]!.content;
		expect(content.match(/\\needspace\{/g)).toHaveLength(1);
		expect(content.includes("\\section{Projects}")).toBe(false);
		expect(content.includes("\\section{Education}")).toBe(false);
		expect(content).toContain("\\end{document}");
	});

	it("distinguishes repeated titles and rejects stale section IDs after source changes", () => {
		const repeated = source.replace("\\section{Education}", "\\section{Projects}");
		const projects = indexOf(repeated).sections.filter((section) => section.title === "Projects");
		expect(projects).toHaveLength(2);
		expect(projects[0]!.id === projects[1]!.id).toBe(false);
		const changed = source.replace("Documented system interfaces.", "Other project facts.");
		expect(() => applyLatexRegionEdits(project(changed), { sectionEdits: [{ path: "main.tex", sectionId: sectionOf("Projects").id }] })).toThrow();
	});

	it("ignores commented or escaped headings and supports starred nested-brace titles", () => {
		const content = source.replace("\\begin{document}", "% \\section{Inactive}\n\\begin{document}")
			.replace("Candidate Name", "Candidate Name\n\\\\section{Literal example}")
			.replace("\\section{Projects}", "\\section*{Projects \\textbf{and Research}}");
		expect(indexOf(content).sections.map((section) => section.title)).toEqual(["Experience", "Projects \\textbf{and Research}", "Education"]);
	});

	it("rejects overlapping section/line edits atomically", () => {
		const before = project();
		const snapshot = JSON.stringify(before);
		const section = sectionOf("Projects");
		expect(() => applyLatexRegionEdits(before, {
			sectionEdits: [{ path: "main.tex", sectionId: section.id }],
			lineEdits: [{ path: "main.tex", startLine: section.startLine, endLine: section.endLine }],
		})).toThrow();
		expect(JSON.stringify(before)).toBe(snapshot);
	});

	it("rejects preamble, PDF-metadata, header, boundary, invalid and reversed ranges", () => {
		for (const [startLine, endLine] of [[1, 1], [lineOf("Candidate Name"), lineOf("Candidate Name")], [lineOf("\\end{document}"), lineOf("\\end{document}")], [999, 999], [15, 10]]) {
			expect(() => applyLatexRegionEdits(project(), { lineEdits: [{ path: "main.tex", startLine, endLine }] })).toThrow();
		}
	});

	it("rejects changed global fonts, new layout overrides and document boundaries", () => {
		const line = lineOf("Built a sensor pipeline.");
		for (const newText of ["\\small Smaller content", "\\geometry{margin=0.1in}", "\\begin{document} New content", "\\needspace{100\\baselineskip} New content"]) {
			expect(() => applyLatexRegionEdits(project(), { lineEdits: [{ path: "main.tex", startLine: line, endLine: line, newText }] })).toThrow();
		}
	});

	it("rejects unsafe paths, non-TeX/binary files, empty operation lists and no-op text", () => {
		expect(latexRegionEditsSchema.safeParse({ lineEdits: [{ path: "../main.tex", startLine: 1, endLine: 1 }] }).success).toBe(false);
		expect(latexRegionEditsSchema.safeParse({ sectionEdits: [] }).success).toBe(false);
		expect(() => applyLatexRegionEdits(project(), {})).toThrow();
		for (const path of ["missing.tex", "template.sty", "image.png"]) expect(() => applyLatexRegionEdits(project(), { lineEdits: [{ path, startLine: 1, endLine: 1 }] })).toThrow();
		const line = lineOf("Built a sensor pipeline.");
		expect(() => applyLatexRegionEdits(project(), { lineEdits: [{ path: "main.tex", startLine: line, endLine: line, newText: "\\resumeItem{Built a sensor pipeline.}" }] })).toThrow();
	});

	it("keeps nested subsections selectable while rejecting overlapping parent/child removal", () => {
		const content = source.replace("\\section{Projects}", "\\section{Projects}\n\\subsection{Research}");
		const sections = indexOf(content).sections;
		const parent = sections.find((section) => section.title === "Projects")!;
		const child = sections.find((section) => section.title === "Research")!;
		expect(parent.startLine < child.startLine).toBe(true);
		expect(parent.endLine).toBe(child.endLine);
		expect(() => applyLatexRegionEdits(project(content), { sectionEdits: [parent, child].map(({ id }) => ({ path: "main.tex", sectionId: id })) })).toThrow();
	});
});
