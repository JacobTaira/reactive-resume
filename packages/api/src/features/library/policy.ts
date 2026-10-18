import type { ResumeFolder, ResumeIndexEntry, ResumeProfile } from "../../dto/library";
import { ORPCError } from "@orpc/client";

/** All writes for one owner are serialized before this check, including concurrent moves. */
export function assertFolderParent(
	folders: Pick<ResumeFolder, "id" | "parentId">[],
	id: string | null,
	parentId: string | null,
) {
	const parents = new Map(folders.map((folder) => [folder.id, folder.parentId]));
	const visited = new Set<string>();
	let current = parentId;
	while (current !== null) {
		if (current === id || visited.has(current)) {
			throw new ORPCError("BAD_REQUEST", { message: "A folder cannot contain itself or one of its parents." });
		}
		if (!parents.has(current)) throw new ORPCError("NOT_FOUND", { message: "Parent folder not found." });
		visited.add(current);
		current = parents.get(current) ?? null;
	}
	const pending = id === null ? [] : [{ id, depth: 1 }];
	const descendants = new Set<string>();
	let subtreeDepth = 1;
	for (let cursor = 0; cursor < pending.length; cursor++) {
		const node = pending[cursor];
		if (!node) continue;
		if (descendants.has(node.id)) {
			throw new ORPCError("BAD_REQUEST", { message: "Folder hierarchy contains a cycle." });
		}
		descendants.add(node.id);
		subtreeDepth = Math.max(subtreeDepth, node.depth);
		for (const folder of folders) {
			if (folder.parentId === node.id) pending.push({ id: folder.id, depth: node.depth + 1 });
		}
	}
	if (visited.size + subtreeDepth > 20) {
		throw new ORPCError("BAD_REQUEST", { message: "Folders can be nested up to 20 levels." });
	}
}

export const companyKey = (company: string) =>
	company.trim().normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/g, " ");

const tokens = (value: string) => new Set(value.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}+#.]{2,}/gu) ?? []);

type MatchInput = { query?: string; company?: string; targetRole?: string; keywords?: string[] };

/** This is lexical reuse guidance, never a hiring probability or an AI-generated fit score. */
export function rankResume(entry: Omit<ResumeIndexEntry, "similarity" | "reuseHints">, input: MatchInput): ResumeIndexEntry {
	const hints: string[] = [];
	let points = 0;
	let maximum = 0;
	if (input.company) {
		maximum += 30;
		if (companyKey(entry.company) === companyKey(input.company)) {
			points += 30;
			hints.push("Same company; review saved company research and prior wording.");
		}
	}
	if (input.targetRole) {
		maximum += 30;
		const wanted = tokens(input.targetRole);
		const existing = tokens(entry.targetRole);
		const overlap = [...wanted].filter((word) => existing.has(word)).length;
		points += wanted.size > 0 ? (overlap / wanted.size) * 30 : 0;
		if (overlap > 0) hints.push("Related role; compare requirements before making a new version.");
	}
	const requested = tokens([input.query ?? "", ...(input.keywords ?? [])].join(" "));
	if (requested.size > 0) {
		maximum += 40;
		const existing = tokens(
			[entry.name, entry.company, entry.targetRole, ...entry.keywords, ...entry.tags, entry.reuseNotes].join(" "),
		);
		const overlap = [...requested].filter((word) => existing.has(word));
		points += (overlap.length / requested.size) * 40;
		if (overlap.length > 0) hints.push(`Shared terms: ${overlap.slice(0, 10).join(", ")}.`);
	}
	if (entry.purpose === "master") hints.push("Master resume: read this as factual source material; tailor a copy.");
	if (entry.evaluationStale) hints.push("Saved evaluation is out of date for this resume or job context; score it again.");
	if (entry.sourceResumeId) hints.push("Derived resume: check the source for newer experience before reusing.");
	return { ...entry, similarity: maximum > 0 ? Math.round((points / maximum) * 100) : 0, reuseHints: hints };
}

export function evaluationStale(
	profile: Pick<ResumeProfile, "score" | "evaluatedResumeUpdatedAt">,
	updatedAt: Date,
) {
	return (
		profile.score !== null &&
		(!profile.evaluatedResumeUpdatedAt ||
			new Date(profile.evaluatedResumeUpdatedAt).getTime() !== updatedAt.getTime())
	);
}
