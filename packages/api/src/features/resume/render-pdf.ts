import { ORPCError } from "@orpc/server";
import { compileLatexProject } from "./latex-compiler";

type RenderPdfInput = Parameters<typeof import("@reactive-resume/pdf/server").createResumePdfFile>[0];

/** Keep browser, API, MCP, and public downloads on the document's chosen rendering engine. */
export async function renderResumePdf(input: RenderPdfInput): Promise<File> {
	if (input.data.latex) {
		const result = await compileLatexProject(input.data.latex);
		if (!result.success) throw new ORPCError("BAD_REQUEST", {
			message: "LaTeX compilation failed. Open the editor to inspect the compiler log.",
		});
		return new File([Buffer.from(result.pdf, "base64")], input.filename, { type: "application/pdf" });
	}
	return (await import("@reactive-resume/pdf/server")).createResumePdfFile(input);
}
