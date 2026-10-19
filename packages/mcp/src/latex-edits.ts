import z from "zod";
import type { LatexProject } from "@reactive-resume/schema/resume/latex";
import { latexPathSchema, latexProjectSchema } from "@reactive-resume/schema/resume/latex";

export const latexTextEditsSchema = z.object({
	edits: z.array(z.object({
		path: latexPathSchema,
		oldText: z.string().min(1).max(20_000),
		newText: z.string().max(20_000),
	}).strict()).min(1).max(100),
	allowFormattingChanges: z.boolean().optional().default(false),
}).strict();

export type LatexTextEdits = z.input<typeof latexTextEditsSchema>;

/** These checks protect known template declarations, not arbitrary TeX execution. */
const layoutCommands = new Set([
	"documentclass", "usepackage", "RequirePackage", "PassOptionsToPackage", "geometry", "newgeometry",
	"restoregeometry", "setlength", "addtolength", "setstretch", "linespread", "fontsize", "selectfont",
	"pagestyle", "thispagestyle", "pagenumbering", "titleformat", "titlespacing", "newcommand", "renewcommand",
	"providecommand", "DeclareRobustCommand", "newenvironment", "renewenvironment", "def", "gdef", "edef", "xdef",
	"vspace", "hspace", "enlargethispage", "resizebox", "scalebox", "input", "include", "includeonly",
]);
const argumentlessLayoutCommands = new Set([
	"raggedright", "raggedleft", "centering", "raggedbottom", "flushbottom", "normalfont", "sffamily",
	"rmfamily", "ttfamily", "small", "footnotesize", "scriptsize", "tiny", "normalsize", "large", "Large",
	"LARGE", "huge", "Huge", "newpage", "clearpage", "pagebreak", "nopagebreak",
]);
const unbracedTargets = new Set([
	"setlength", "addtolength", "newcommand", "renewcommand", "providecommand", "DeclareRobustCommand",
	"def", "gdef", "edef", "xdef",
]);
const layoutEnvironments = new Set(["document", "center", "flushleft", "flushright", "minipage", "multicols"]);

function withoutComments(source: string): string {
	return source.replace(/(\\[\s\S])|%[^\r\n]*/g, (match, escaped: string | undefined) => escaped ?? " ".repeat(match.length));
}

function groupEnd(source: string, start: number): number {
	const opening = source[start];
	const closing = opening === "{" ? "}" : "]";
	let depth = 1;
	for (let index = start + 1; index < source.length; index++) {
		if (source[index] === "\\") { index++; continue; }
		if (source[index] === opening) depth++;
		if (source[index] === closing && --depth === 0) return index + 1;
	}
	throw new Error("Unbalanced LaTeX layout declaration. Preserve the template or explicitly allow formatting changes.");
}

function formattingSignatures(content: string): string[] {
	const source = withoutComments(content);
	const signatures: string[] = [];
	for (const match of source.matchAll(/\\([A-Za-z@]+|[^A-Za-z@])/g)) {
		const name = match[1]!;
		if (argumentlessLayoutCommands.has(name)) { signatures.push(name); continue; }
		if (!layoutCommands.has(name) && name !== "begin" && name !== "end") continue;
		let end = match.index + match[0].length;
		if (source[end] === "*") end++;
		if (unbracedTargets.has(name)) {
			const target = /^\s*\\[A-Za-z@]+/.exec(source.slice(end));
			if (target) end += target[0].length;
		}
		const groups: string[] = [];
		while (end < source.length) {
			const start = end + (/^\s*/.exec(source.slice(end))?.[0].length ?? 0);
			if (source[start] !== "{" && source[start] !== "[") break;
			end = groupEnd(source, start);
			groups.push(source.slice(start, end));
			if (name === "begin" || name === "end") break;
		}
		if ((name === "begin" || name === "end") && !layoutEnvironments.has(groups[0]?.slice(1, -1).trim() ?? "")) continue;
		signatures.push(source.slice(match.index, end).replace(/\s+/g, " "));
	}
	return signatures;
}

function preamble(content: string): string | null {
	const source = withoutComments(content);
	for (const match of source.matchAll(/\\([A-Za-z@]+|[^A-Za-z@])/g)) {
		if (match[1] !== "begin") continue;
		const document = /^\s*\{\s*document\s*\}/.exec(source.slice(match.index + match[0].length));
		if (document) return content.slice(0, match.index + match[0].length + document[0].length);
	}
	return null;
}

/** Keep the saved design intact while changing content; explicit user-requested redesign can bypass this guard. */
export function assertLatexFormattingPreserved(before: LatexProject, after: LatexProject): void {
	if (before.engine !== after.engine || before.entrypoint !== after.entrypoint || before.files.length !== after.files.length) {
		throw new Error("LaTeX template files, engine and entrypoint must be preserved unless formatting changes are explicitly allowed.");
	}
	for (const original of before.files) {
		const edited = after.files.find((file) => file.path === original.path);
		if (!edited || edited.encoding !== original.encoding) throw new Error(`Preserve the LaTeX file and encoding: ${original.path}.`);
		if (original.content === edited.content) continue;
		if (original.encoding !== "utf-8" || !original.path.toLowerCase().endsWith(".tex")) {
			throw new Error(`Supporting template files must be preserved: ${original.path}.`);
		}
		const beforePreamble = preamble(original.content);
		const afterPreamble = preamble(edited.content);
		if (beforePreamble !== afterPreamble || (original.path === before.entrypoint && beforePreamble === null)) {
			throw new Error(`Preserve the original document preamble in ${original.path}; change resume body text only.`);
		}
		if (JSON.stringify(formattingSignatures(original.content)) !== JSON.stringify(formattingSignatures(edited.content))) {
			throw new Error(`Preserve existing LaTeX layout declarations in ${original.path}; change resume text instead of alignment, size or spacing.`);
		}
	}
}

/** Resolve every edit against the original snapshot before changing anything. Never performs a fuzzy replacement. */
export function applyLatexTextEdits(project: LatexProject, input: LatexTextEdits) {
	const options = latexTextEditsSchema.parse(input);
	const byFile = new Map<string, { start: number; end: number; newText: string }[]>();
	for (const [index, edit] of options.edits.entries()) {
		const file = project.files.find((candidate) => candidate.path === edit.path);
		if (!file || file.encoding !== "utf-8" || !file.path.toLowerCase().endsWith(".tex")) {
			throw new Error(`Edit ${index + 1} must target an existing UTF-8 .tex file.`);
		}
		if (edit.oldText === edit.newText) throw new Error(`Edit ${index + 1} makes no change.`);
		const start = file.content.indexOf(edit.oldText);
		if (start === -1) throw new Error(`Edit ${index + 1} has no exact match in ${edit.path}. Read the current source before retrying.`);
		if (file.content.indexOf(edit.oldText, start + 1) !== -1) {
			throw new Error(`Edit ${index + 1} is ambiguous in ${edit.path}. Include more surrounding source text.`);
		}
		const edits = byFile.get(edit.path) ?? [];
		edits.push({ start, end: start + edit.oldText.length, newText: edit.newText });
		byFile.set(edit.path, edits);
	}
	for (const [path, edits] of byFile) {
		edits.sort((left, right) => left.start - right.start);
		for (let index = 1; index < edits.length; index++) {
			if (edits[index]!.start < edits[index - 1]!.end) throw new Error(`Overlapping edits in ${path}. Combine them into one exact replacement.`);
		}
	}
	const files = project.files.map((file) => {
		const edits = byFile.get(file.path);
		if (!edits) return file;
		let content = file.content;
		for (const edit of [...edits].reverse()) content = content.slice(0, edit.start) + edit.newText + content.slice(edit.end);
		return { ...file, content };
	});
	const updated = latexProjectSchema.parse({ ...project, files });
	if (!options.allowFormattingChanges) assertLatexFormattingPreserved(project, updated);
	return { project: updated, changedFiles: [...byFile.keys()], appliedEdits: options.edits.length };
}
