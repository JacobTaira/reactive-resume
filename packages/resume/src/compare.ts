import type { ResumeData } from "@reactive-resume/schema/resume/data";

export type ComparisonLine = {
	kind: "added" | "removed" | "context";
	text: string;
	oldLine: number | null;
	newLine: number | null;
};

export type ComparisonFile = {
	path: string;
	kind: "added" | "removed" | "modified";
	binary: boolean;
	addedLines: number;
	removedLines: number;
	coarse: boolean;
	truncated: boolean;
	lines: ComparisonLine[];
};

export type ResumeComparison = {
	files: ComparisonFile[];
	comparison: "latex" | "structured" | "mixed";
	identical: boolean;
	truncated: boolean;
};

const MAX_CELLS = 250_000;
const MAX_INPUT_LINES = 20_000;
const MAX_OUTPUT_LINES = 600;
const MAX_TOTAL_LINES = 1_000;
const MAX_TEXT = 80_000;
const MAX_LINE = 4_000;

function sortedJson(value: unknown): string {
	return JSON.stringify(value, (_key, item: unknown) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return item;
		return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)));
	}, 2);
}

type Content = { text: string; binary: boolean };

function files(data: ResumeData, includeStructured: boolean): Map<string, Content> {
	const result = new Map<string, Content>();
	if (data.latex) {
		for (const file of data.latex.files) {
			result.set(`latex/${file.path}`, { text: file.content, binary: file.encoding === "base64" });
		}
		result.set("latex/project.json", {
			text: sortedJson({ engine: data.latex.engine, entrypoint: data.latex.entrypoint }), binary: false,
		});
	}
	if (includeStructured) {
		const { latex: _latex, ...structured } = data;
		// Author notes and check choices are private workflow data, not printed resume content.
		const { notes: _notes, check: _check, ...metadata } = data.metadata;
		result.set("resume.json", { text: sortedJson({ ...structured, metadata }), binary: false });
	}
	return result;
}

const countLines = (text: string) => {
	let count = 1;
	for (let index = 0; index < text.length; index++) if (text[index] === "\n") count++;
	return count;
};

/** Exact additions/removals; bounded LCS falls back to a clearly marked replacement for large edits. */
function lineDiff(before: string | undefined, after: string | undefined) {
	const oldLines = before === undefined ? [] : before.split("\n", MAX_INPUT_LINES + 1);
	const newLines = after === undefined ? [] : after.split("\n", MAX_INPUT_LINES + 1);
	const lines: ComparisonLine[] = [];
	const oversized = oldLines.length > MAX_INPUT_LINES || newLines.length > MAX_INPUT_LINES;
	let prefix = 0;
	let suffix = 0;
	if (!oversized) {
		while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
		while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines.at(-1 - suffix) === newLines.at(-1 - suffix)) suffix++;
	}
	const oldEnd = oldLines.length - suffix;
	const newEnd = newLines.length - suffix;
	const rows = oldEnd - prefix;
	const cols = newEnd - prefix;
	const coarse = oversized || (rows + 1) * (cols + 1) > MAX_CELLS;
	let addedLines = 0;
	let removedLines = 0;
	const append = (kind: ComparisonLine["kind"], text: string, oldLine: number | null, newLine: number | null) => {
		if (kind === "added") addedLines++;
		if (kind === "removed") removedLines++;
		// Counts describe the entire diff even when display output is shortened.
		if (lines.length < MAX_OUTPUT_LINES) lines.push({ kind, text, oldLine, newLine });
	};
	for (let index = Math.max(0, prefix - 3); index < prefix; index++) append("context", oldLines[index] ?? "", index + 1, index + 1);
	if (coarse) {
		for (let index = prefix; index < oldEnd; index++) append("removed", oldLines[index] ?? "", index + 1, null);
		for (let index = prefix; index < newEnd; index++) append("added", newLines[index] ?? "", null, index + 1);
		if (oversized) {
			removedLines = before === undefined ? 0 : countLines(before);
			addedLines = after === undefined ? 0 : countLines(after);
		}
	} else {
		const width = cols + 1;
		const lcs = new Uint32Array((rows + 1) * width);
		for (let row = rows - 1; row >= 0; row--) for (let col = cols - 1; col >= 0; col--) {
			lcs[row * width + col] = oldLines[prefix + row] === newLines[prefix + col]
				? 1 + (lcs[(row + 1) * width + col + 1] ?? 0)
				: Math.max(lcs[(row + 1) * width + col] ?? 0, lcs[row * width + col + 1] ?? 0);
		}
		let row = 0;
		let col = 0;
		while (row < rows || col < cols) {
			if (row < rows && col < cols && oldLines[prefix + row] === newLines[prefix + col]) {
				append("context", oldLines[prefix + row] ?? "", prefix + row + 1, prefix + col + 1);
				row++; col++;
			} else if (row < rows && (col >= cols || (lcs[(row + 1) * width + col] ?? 0) >= (lcs[row * width + col + 1] ?? 0))) {
				append("removed", oldLines[prefix + row] ?? "", prefix + row + 1, null); row++;
			} else {
				append("added", newLines[prefix + col] ?? "", null, prefix + col + 1); col++;
			}
		}
	}
	for (let index = 0; index < Math.min(3, suffix); index++) append("context", oldLines[oldEnd + index] ?? "", oldEnd + index + 1, newEnd + index + 1);
	return { lines, addedLines, removedLines, coarse, truncated: oversized || addedLines + removedLines > MAX_OUTPUT_LINES || lines.length === MAX_OUTPUT_LINES };
}

/** Compares printable data without consulting a model, database, or external service. */
export function compareResumeData(before: ResumeData, after: ResumeData): ResumeComparison {
	const comparison = before.latex && after.latex ? "latex" : before.latex || after.latex ? "mixed" : "structured";
	const oldFiles = files(before, comparison !== "latex");
	const newFiles = files(after, comparison !== "latex");
	const paths = [...new Set([...oldFiles.keys(), ...newFiles.keys()])].sort();
	const output: ComparisonFile[] = [];
	let remaining = MAX_TEXT;
	let remainingLines = MAX_TOTAL_LINES;
	for (const path of paths) {
		const oldFile = oldFiles.get(path);
		const newFile = newFiles.get(path);
		if (oldFile?.text === newFile?.text && oldFile?.binary === newFile?.binary) continue;
		const kind = !oldFile ? "added" : !newFile ? "removed" : "modified";
		const binary = Boolean(oldFile?.binary || newFile?.binary);
		const diff = binary ? { lines: [], addedLines: 0, removedLines: 0, coarse: false, truncated: false } : lineDiff(oldFile?.text, newFile?.text);
		const visibleLines: ComparisonLine[] = [];
		for (const line of diff.lines) {
			if (remainingLines === 0 || remaining === 0) {
				diff.truncated = true;
				break;
			}
			const text = line.text.slice(0, Math.min(MAX_LINE, remaining));
			if (text.length !== line.text.length) diff.truncated = true;
			remaining -= text.length;
			remainingLines--;
			visibleLines.push({ ...line, text });
		}
		output.push({ path, kind, binary, ...diff, lines: visibleLines });
	}
	return { files: output, comparison, identical: output.length === 0, truncated: output.some((file) => file.truncated) };
}
