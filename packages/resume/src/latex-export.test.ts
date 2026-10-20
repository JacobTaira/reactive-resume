import { describe, expect, it } from "vitest";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";
import { getResumeExportData } from "./export-sections";

describe("LaTeX export selection", () => {
	it("keeps the resume source for resumes and excludes it from structured cover-letter exports", () => {
		const data = structuredClone(defaultResumeData);
		data.latex = {
			engine: "pdflatex", entrypoint: "main.tex",
			files: [{ path: "main.tex", encoding: "utf-8", content: "resume source" }],
		};
		expect(getResumeExportData(data, "resume").latex).toEqual(data.latex);
		expect(getResumeExportData(data, "cover-letter").latex).toBeUndefined();
		expect(data.latex.files[0]?.content).toBe("resume source");
	});
});
