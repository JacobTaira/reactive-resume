import { describe, expect, it } from "vitest";
import { resumeDataSchema } from "./data";
import { defaultResumeData } from "./default";
import { latexProjectSchema, LATEX_LIMITS } from "./latex";

const source = "\\documentclass{article}\n% Keep this comment.\n\\begin{document}Example\\end{document}\n";
const project = () => ({
	engine: "pdflatex" as const,
	entrypoint: "main.tex",
	files: [{ path: "main.tex", encoding: "utf-8" as const, content: source }],
});

describe("LaTeX resume projects", () => {
	it("preserves source, comments and assets through resume JSON round trips", () => {
		const latex = {
			...project(),
			files: [...project().files, { path: "assets/image.png", encoding: "base64", content: "iVBORw==" }],
		};
		const data = resumeDataSchema.parse(JSON.parse(JSON.stringify({ ...defaultResumeData, latex })));
		expect(data.latex).toEqual(latex);
	});

	it.each(["../main.tex", "/main.tex", "a/../main.tex", "a\\main.tex", ".hidden.tex", "rr-build/main.tex"])(
		"rejects unsafe project path %s",
		(path) => {
			const data = project();
			data.entrypoint = path;
			data.files[0] = { path, encoding: "utf-8", content: source };
			expect(latexProjectSchema.safeParse(data).success).toBe(false);
		},
	);

	it("rejects duplicate names and file/directory collisions irrespective of case", () => {
		const duplicate = project();
		duplicate.files.push({ path: "MAIN.tex", encoding: "utf-8", content: "" });
		expect(latexProjectSchema.safeParse(duplicate).success).toBe(false);
		const conflict = project();
		conflict.files.push({ path: "MAIN.tex/part.tex", encoding: "utf-8", content: "" });
		expect(latexProjectSchema.safeParse(conflict).success).toBe(false);
	});

	it("measures UTF-8 bytes rather than character count", () => {
		const data = project();
		data.files[0] = { path: "main.tex", encoding: "utf-8", content: "界".repeat(LATEX_LIMITS.fileBytes / 3 + 1) };
		expect(latexProjectSchema.safeParse(data).success).toBe(false);
	});

	it("rejects missing main documents and malformed binary assets", () => {
		expect(latexProjectSchema.safeParse({ ...project(), entrypoint: "missing.tex" }).success).toBe(false);
		const data = {
			...project(),
			files: [...project().files, { path: "image.png", encoding: "base64", content: "not base64!" }],
		};
		expect(latexProjectSchema.safeParse(data).success).toBe(false);
	});
});
