import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { compactCompileLog, latexFileManifest } from "./latex-context";

const project = {
	engine: "pdflatex" as const,
	entrypoint: "main.tex",
	files: [
		{ path: "main.tex", encoding: "utf-8" as const, content: "Exact résumé source\n" },
		{ path: "ACS.tex", encoding: "utf-8" as const, content: "Unused alternate source".repeat(1000) },
		{ path: "asset.png", encoding: "base64" as const, content: "AQID" },
	],
};

describe("compact LaTeX context", () => {
	it("returns exact entrypoint bytes while retaining a manifest of omitted files", () => {
		const files = latexFileManifest(project);
		expect(files).toHaveLength(3);
		expect(files[0]).toMatchObject({
			index: 0, included: true, content: project.files[0]!.content,
			byteLength: Buffer.byteLength(project.files[0]!.content),
			sha256: createHash("sha256").update(project.files[0]!.content).digest("hex"),
		});
		expect(files[1]).toMatchObject({ path: "ACS.tex", index: 1, included: false });
		expect(files[1]).not.toHaveProperty("content");
		expect(files[2]).toMatchObject({ path: "asset.png", byteLength: 3, included: false });
	});

	it("loads only explicitly selected supporting files and rejects missing paths", () => {
		const files = latexFileManifest(project, ["ACS.tex"]);
		expect(files[0]).not.toHaveProperty("content");
		expect(files[1]?.content).toBe(project.files[1]!.content);
		expect(() => latexFileManifest(project, ["missing.tex"])).toThrow();
	});

	it("summarizes successful logs while retaining warnings and exact failure logs", () => {
		const log = "ordinary TeX output\n".repeat(1000) + "LaTeX Warning: check labels\nOverfull \\hbox (2pt too wide)";
		const result = compactCompileLog(log, true);
		expect(result.log).toContain("LaTeX Warning");
		expect(result.log).toContain("Overfull");
		expect(result.log.length).toBeLessThan(log.length);
		expect(result.logTruncated).toBe(true);
		expect(result.logCharacters).toBe(log.length);
		expect(compactCompileLog(log, false).log).toBe(log);
		expect(compactCompileLog(log, true, true).log).toBe(log);
	});
});
