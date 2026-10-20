import type { LatexProject } from "@reactive-resume/schema/resume/latex";
import { createHash } from "node:crypto";
import z from "zod";
import { latexPathSchema, latexProjectSchema } from "@reactive-resume/schema/resume/latex";
import { assertLatexFormattingPreserved, withoutComments } from "./latex-edits";

export const latexRegionEditsShape = {
	sectionEdits: z.array(z.strictObject({
		path: latexPathSchema,
		sectionId: z.string().min(1).max(80),
		newText: z.string().max(40_000).optional().describe("Omit to remove the complete section. For replacement, send only the final section source."),
	})).min(1).max(100).optional(),
	lineEdits: z.array(z.strictObject({
		path: latexPathSchema,
		startLine: z.number().int().positive(),
		endLine: z.number().int().positive(),
		newText: z.string().max(40_000).optional().describe("Omit to delete these inclusive lines. Otherwise send only replacement source, without line-number prefixes."),
	})).min(1).max(100).optional(),
};
export const latexRegionEditsSchema = z.strictObject(latexRegionEditsShape);
type RegionEdits = z.input<typeof latexRegionEditsSchema>;
type SourceLine = { start: number; end: number; text: string; ending: string };

function sourceLines(content: string): SourceLine[] {
	const lines: SourceLine[] = [];
	for (const match of content.matchAll(/([^\r\n]*)(\r\n|\r|\n|$)/g)) {
		if (!match[0].length) continue;
		lines.push({ start: match.index, end: match.index + match[0].length, text: match[1]!, ending: match[2]! });
	}
	return lines.length ? lines : [{ start: 0, end: 0, text: "", ending: "" }];
}

function groupEnd(source: string, start: number): number | null {
	let depth = 0;
	for (let index = start; index < source.length; index++) {
		if (source[index] === "\\") { index++; continue; }
		if (source[index] === "{") depth++;
		if (source[index] === "}" && --depth === 0) return index + 1;
	}
	return null;
}

function documentBody(source: string): { start: number; end: number } | null {
	let start: number | undefined;
	for (const match of source.matchAll(/\\([A-Za-z@]+|[^A-Za-z@])/g)) {
		if (match[1] !== "begin" && match[1] !== "end") continue;
		const document = /^\s*\{\s*document\s*\}/.exec(source.slice(match.index + match[0].length));
		if (!document) continue;
		if (match[1] === "begin" && start === undefined) start = match.index + match[0].length + document[0].length;
		else if (match[1] === "end" && start !== undefined) return { start, end: match.index };
	}
	return null;
}

/** Whole standalone spacing lines immediately before a heading belong to that section. */
function spacingLine(line: string): boolean {
	const source = withoutComments(line).trim();
	if (!source) return true;
	let cursor = 0;
	while (cursor < source.length) {
		const pageBreak = /^\\(?:newpage|clearpage|pagebreak|nopagebreak)(?:\s*\[[0-4]\])?\s*/.exec(source.slice(cursor));
		if (pageBreak) { cursor += pageBreak[0].length; continue; }
		const command = /^\\(?:vspace|hspace|needspace|Needspace)\*?\s*/.exec(source.slice(cursor));
		if (!command) return false;
		cursor += command[0].length;
		if (source[cursor] !== "{") return false;
		const end = groupEnd(source, cursor);
		if (end === null) return false;
		cursor = end + (/^\s*/.exec(source.slice(end))?.[0].length ?? 0);
	}
	return true;
}

/** A read-only, numbered view. Offsets always refer to the original saved snapshot, never to numbered text. */
export function latexSourceIndex(path: string, content: string, isEntrypoint = false) {
	const lines = sourceLines(content);
	const masked = withoutComments(content);
	const bounds = documentBody(masked);
	const body = bounds ?? (isEntrypoint ? null : { start: 0, end: content.length });
	const headings: { title: string; level: number; startLine: number }[] = [];
	if (body) {
		for (const match of masked.matchAll(/\\([A-Za-z@]+|[^A-Za-z@])/g)) {
			const name = match[1]!;
			const level = ["section", "cvsection", "resumeSection", "resumesection"].includes(name) ? 1 : name === "subsection" ? 2 : null;
			if (level === null || match.index < body.start || match.index >= body.end) continue;
			const opening = /^\*?\s*(?:\[[^\]]*\]\s*)?\{/.exec(masked.slice(match.index + match[0].length));
			if (!opening) continue;
			const groupStart = match.index + match[0].length + opening[0].length - 1;
			const end = groupEnd(masked, groupStart);
			if (end === null || end > body.end) continue;
			let lineIndex = lines.findIndex((line) => line.start <= match.index && match.index < line.end);
			if (lineIndex < 0 || masked.slice(lines[lineIndex]!.start, match.index).trim()) continue;
			while (lineIndex > 0 && lines[lineIndex - 1]!.start >= body.start && spacingLine(lines[lineIndex - 1]!.text)) lineIndex--;
			headings.push({ title: content.slice(groupStart + 1, end - 1).trim().slice(0, 200), level, startLine: lineIndex + 1 });
		}
	}
	const firstBodyLine = body ? lines.findIndex((line) => line.start >= body.start && line.end <= body.end) : -1;
	let lastBodyLine = -1;
	if (body) for (const [index, line] of lines.entries()) if (line.start >= body.start && line.end <= body.end) lastBodyLine = index;
	const startLine = headings[0]?.startLine ?? firstBodyLine + 1;
	const editableRange = firstBodyLine >= 0 && lastBodyLine >= firstBodyLine && startLine <= lastBodyLine + 1
		? { startLine, endLine: lastBodyLine + 1 } : null;
	const sections = headings.map((heading, index) => {
		const next = headings.slice(index + 1).find((candidate) => candidate.level <= heading.level);
		const endLine = next ? next.startLine - 1 : lastBodyLine + 1;
		const text = content.slice(lines[heading.startLine - 1]!.start, lines[endLine - 1]?.end ?? content.length);
		return {
			id: `s-${createHash("sha256").update(`${path}\0${heading.startLine}\0${text}`).digest("hex").slice(0, 16)}`,
			title: heading.title, startLine: heading.startLine, endLine,
		};
	}).filter((section) => editableRange && section.startLine <= section.endLine && section.startLine >= editableRange.startLine && section.endLine <= editableRange.endLine);
	return {
		lineCount: lines.length, editableRange, sections,
		numberedSource: lines.map((line, index) => `${index + 1}|${line.text}`).join("\n"),
	};
}

/** Edit by section ID or inclusive line range, without asking the assistant to echo deleted source. */
export function applyLatexRegionEdits(project: LatexProject, input: RegionEdits) {
	const options = latexRegionEditsSchema.parse(input);
	if (!options.sectionEdits?.length && !options.lineEdits?.length) throw new Error("Supply sectionEdits or lineEdits.");
	const changes = new Map<string, { start: number; end: number; text: string }[]>();
	const add = (path: string, startLine: number, endLine: number, newText: string | undefined) => {
		const file = project.files.find((candidate) => candidate.path === path);
		if (!file || file.encoding !== "utf-8" || !path.toLowerCase().endsWith(".tex")) throw new Error(`Choose an existing UTF-8 .tex file: ${path}.`);
		const index = latexSourceIndex(path, file.content, path === project.entrypoint);
		const range = index.editableRange;
		if (!range || startLine > endLine || startLine < range.startLine || endLine > range.endLine) {
			throw new Error(`Lines ${startLine}–${endLine} are outside the editable body in ${path}. Preamble, PDF metadata, header and document boundaries stay unchanged; use the returned editableRange.`);
		}
		const lines = sourceLines(file.content);
		const start = lines[startLine - 1]!.start;
		const end = lines[endLine - 1]!.end;
		const ending = lines[endLine - 1]!.ending;
		let text = newText ?? "";
		if (text && ending && !/[\r\n]$/.test(text)) text += ending;
		if (text === file.content.slice(start, end)) throw new Error(`Edit makes no change in ${path}.`);
		const edits = changes.get(path) ?? [];
		edits.push({ start, end, text });
		changes.set(path, edits);
	};
	for (const edit of options.sectionEdits ?? []) {
		const file = project.files.find((candidate) => candidate.path === edit.path && candidate.encoding === "utf-8");
		const section = file && latexSourceIndex(file.path, file.content, file.path === project.entrypoint).sections.find(({ id }) => id === edit.sectionId);
		if (!section) throw new Error(`Section ${edit.sectionId} is not in the current ${edit.path} source. Use the returned current section IDs.`);
		add(edit.path, section.startLine, section.endLine, edit.newText);
	}
	for (const edit of options.lineEdits ?? []) add(edit.path, edit.startLine, edit.endLine, edit.newText);
	for (const [path, edits] of changes) {
		edits.sort((a, b) => a.start - b.start);
		for (let index = 1; index < edits.length; index++) if (edits[index]!.start < edits[index - 1]!.end) throw new Error(`Overlapping section/line edits in ${path}. Use one replacement for that region.`);
	}
	const files = project.files.map((file) => {
		let content = file.content;
		for (const edit of [...(changes.get(file.path) ?? [])].reverse()) content = content.slice(0, edit.start) + edit.text + content.slice(edit.end);
		return { ...file, content };
	});
	const updated = latexProjectSchema.parse({ ...project, files });
	assertLatexFormattingPreserved(project, updated);
	return { project: updated, changedFiles: [...changes.keys()], appliedEdits: [...changes.values()].reduce((count, edits) => count + edits.length, 0) };
}
