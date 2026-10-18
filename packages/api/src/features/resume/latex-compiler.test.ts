import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compileLatexProject } from "./latex-compiler";

const mocks = vi.hoisted(() => ({
	env: { LATEX_COMPILER_URL: "http://compiler:8010/", LATEX_COMPILER_TOKEN: "test-token-".repeat(4) },
	fetch: vi.fn(),
}));

vi.mock("@reactive-resume/env/server", () => ({ env: mocks.env }));

const project = {
	engine: "pdflatex" as const,
	entrypoint: "main.tex",
	files: [{ path: "main.tex", encoding: "utf-8" as const, content: "example" }],
};

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal("fetch", mocks.fetch);
});
afterEach(() => vi.unstubAllGlobals());

describe("LaTeX compiler client", () => {
	it("sends only the project to the operator-configured compiler", async () => {
		mocks.fetch.mockResolvedValueOnce(Response.json({ success: true, pdf: "JVBERi0=", log: "done" }));
		await expect(compileLatexProject(project)).resolves.toEqual({ success: true, pdf: "JVBERi0=", log: "done" });
		expect(mocks.fetch).toHaveBeenCalledWith("http://compiler:8010/compile", expect.objectContaining({
			method: "POST", body: JSON.stringify(project), redirect: "error",
			headers: { "content-type": "application/json", authorization: `Bearer ${mocks.env.LATEX_COMPILER_TOKEN}` },
		}));
	});

	it("returns compiler failures without manufacturing a successful PDF", async () => {
		mocks.fetch.mockResolvedValueOnce(Response.json({ success: false, log: "Undefined control sequence" }));
		await expect(compileLatexProject(project)).resolves.toEqual({ success: false, log: "Undefined control sequence" });
	});

	it("rejects invalid projects before contacting the compiler", async () => {
		await expect(compileLatexProject({ ...project, entrypoint: "missing.tex" })).rejects.toThrow();
		expect(mocks.fetch).not.toHaveBeenCalled();
	});

	it("does not expose worker response bodies or tokens on connection failures", async () => {
		mocks.fetch.mockResolvedValueOnce(new Response("internal paths and credentials", { status: 503 }));
		await expect(compileLatexProject(project)).rejects.toThrow("busy");
		mocks.fetch.mockRejectedValueOnce(new Error(mocks.env.LATEX_COMPILER_TOKEN));
		await expect(compileLatexProject(project)).rejects.toThrow("Could not reach the LaTeX compiler");
	});
});
