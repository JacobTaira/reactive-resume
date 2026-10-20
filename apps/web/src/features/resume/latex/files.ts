import type { LatexProject } from "@reactive-resume/schema/resume/latex";
import { strToU8, zipSync } from "fflate";
import { latexProjectSchema } from "@reactive-resume/schema/resume/latex";
import { client } from "@/libs/orpc/client";

export function base64Bytes(content: string): Uint8Array<ArrayBuffer> {
	return Uint8Array.from(atob(content), (character) => character.charCodeAt(0));
}

export function projectArchive(project: LatexProject): Blob {
	const checked = latexProjectSchema.parse(project);
	const files = Object.fromEntries(checked.files.map((file) => [
		file.path, file.encoding === "utf-8" ? strToU8(file.content) : base64Bytes(file.content),
	]));
	return new Blob([new Uint8Array(zipSync(files))], { type: "application/zip" });
}

export async function compileLatexBlob(project: LatexProject): Promise<Blob> {
	const result = await client.resume.latex.render({ project });
	if (!result.success) throw new Error(result.log || "LaTeX compilation failed.");
	return new Blob([base64Bytes(result.pdf)], { type: "application/pdf" });
}
