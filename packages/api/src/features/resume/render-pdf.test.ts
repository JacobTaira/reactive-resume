import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";
import { renderResumePdf } from "./render-pdf";

const mocks = vi.hoisted(() => ({ compile: vi.fn(), renderStructured: vi.fn() }));
vi.mock("./latex-compiler", () => ({ compileLatexProject: mocks.compile }));
vi.mock("@reactive-resume/pdf/server", () => ({ createResumePdfFile: mocks.renderStructured }));

beforeEach(() => vi.clearAllMocks());

describe("resume PDF dispatch", () => {
	it("uses the TeX project for a LaTeX document instead of empty structured sections", async () => {
		const data = structuredClone(defaultResumeData);
		data.latex = {
			engine: "pdflatex", entrypoint: "main.tex",
			files: [{ path: "main.tex", encoding: "utf-8", content: "example" }],
		};
		mocks.compile.mockResolvedValueOnce({ success: true, pdf: "JVBERi0=", log: "done" });
		const file = await renderResumePdf({ data, filename: "tailored.pdf" });
		expect(file.name).toBe("tailored.pdf");
		expect(await file.text()).toBe("%PDF-");
		expect(mocks.compile).toHaveBeenCalledWith(data.latex);
		expect(mocks.renderStructured).not.toHaveBeenCalled();
	});

	it("rejects a failed compilation rather than exporting the unrelated form template", async () => {
		const data = structuredClone(defaultResumeData);
		data.latex = {
			engine: "pdflatex", entrypoint: "main.tex",
			files: [{ path: "main.tex", encoding: "utf-8", content: "invalid" }],
		};
		mocks.compile.mockResolvedValueOnce({ success: false, log: "error" });
		await expect(renderResumePdf({ data, filename: "resume.pdf" })).rejects.toThrow("LaTeX compilation failed");
		expect(mocks.renderStructured).not.toHaveBeenCalled();
	});

	it("keeps the existing renderer for standard resumes", async () => {
		const expected = new File(["structured"], "resume.pdf", { type: "application/pdf" });
		mocks.renderStructured.mockResolvedValueOnce(expected);
		await expect(renderResumePdf({ data: defaultResumeData, filename: "resume.pdf" })).resolves.toBe(expected);
		expect(mocks.compile).not.toHaveBeenCalled();
	});
});
