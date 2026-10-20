import type { LatexProject } from "@reactive-resume/schema/resume/latex";
import { createHash } from "node:crypto";

export function latexFileManifest(project: LatexProject, filePaths: string[] = [project.entrypoint]) {
	const selected = new Set(filePaths);
	for (const path of selected) {
		if (!project.files.some((file) => file.path === path)) throw new Error(`Project file not found: ${path}`);
	}
	return project.files.map((file, index) => {
		const bytes = Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8");
		return {
			index,
			path: file.path,
			encoding: file.encoding,
			byteLength: bytes.byteLength,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			included: selected.has(file.path),
			...(selected.has(file.path) ? { content: file.content } : {}),
		};
	});
}

/** Keep actual PDF diagnostics while omitting ordinary successful TeX chatter. */
export function compactCompileLog(log: string, success: boolean, includeLog = false) {
	if (!success || includeLog) return { log, logTruncated: false, logCharacters: log.length };
	const warnings = log.split(/\r?\n/).filter((line) => /warning|overfull|underfull|missing character|^!/i.test(line));
	const summary = warnings.length ? warnings.join("\n").slice(0, 3000) : "Compilation succeeded.";
	return { log: summary, logTruncated: summary !== log, logCharacters: log.length };
}
