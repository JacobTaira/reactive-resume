import type { CompactResumeOutcome, ResumeFolder, ResumeIndexEntry, ResumeOutcome, ResumeProfile } from "../../dto/library";
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
const genericRoleTerms = new Set([
	"and", "for", "the", "with", "senior", "junior", "staff", "lead", "principal", "associate",
	"engineer", "engineering", "developer", "specialist", "manager", "director",
]);

type MatchInput = { query?: string; company?: string; targetRole?: string; keywords?: string[] };

export type ApplicationOutcomeContext = {
	resumeId: string | null;
	status: string;
	closedReason: string | null;
	sentResumeVersionId: string | null;
	sentResumeId: string | null;
	updatedAt: Date;
	activityStages: string[];
};

export const positiveOutcomeStage = (stage: string): CompactResumeOutcome["strongestStage"] => {
	if (stage === "offer") return "offer";
	if (stage === "interview") return "interview";
	if (stage === "applied" || stage === "screening") return "applied";
	return "not_applied";
};

export const outcomeStageWeight = { not_applied: 0, applied: 1, interview: 2, offer: 3 } as const;

/** Recorded outcomes show correlation only; they do not establish that a resume caused an outcome. */
export function resolveResumeOutcome(
	resumeId: string,
	profile: ResumeOutcome,
	application: ApplicationOutcomeContext | ApplicationOutcomeContext[] | null,
): CompactResumeOutcome {
	const recorded = profile.recordedAt !== null;
	const linked = (Array.isArray(application) ? application : application ? [application] : [])
		.filter((item) => item.resumeId === resumeId &&
			item.sentResumeVersionId !== null && item.sentResumeId === resumeId);
	let selected: { stage: ResumeOutcome["stage"]; strongestStage: CompactResumeOutcome["strongestStage"]; updatedAt: Date } | null = null;
	let strongestStage = positiveOutcomeStage(recorded ? profile.stage : "not_applied");
	if (recorded && outcomeStageWeight[profile.reachedStage] > outcomeStageWeight[strongestStage]) {
		strongestStage = profile.reachedStage;
	}
	for (const item of linked) {
		let applicationStage: ResumeOutcome["stage"] = positiveOutcomeStage(item.status);
		if (item.status === "closed") {
			if (item.closedReason === "accepted") applicationStage = "offer";
			else if (item.closedReason === "not-selected") applicationStage = "rejected";
			else if (item.closedReason === "withdrew" || item.closedReason === "accepted-other") applicationStage = "withdrawn";
			else if (item.sentResumeVersionId) applicationStage = "applied";
		}
		let reached = positiveOutcomeStage(applicationStage);
		for (const stage of item.sentResumeVersionId ? item.activityStages : []) {
			const candidate = positiveOutcomeStage(stage);
			if (outcomeStageWeight[candidate] > outcomeStageWeight[reached]) reached = candidate;
		}
		if (outcomeStageWeight[reached] > outcomeStageWeight[strongestStage]) strongestStage = reached;
		if (!selected || outcomeStageWeight[reached] > outcomeStageWeight[selected.strongestStage] ||
			(outcomeStageWeight[reached] === outcomeStageWeight[selected.strongestStage] && item.updatedAt > selected.updatedAt)) {
			selected = { stage: applicationStage, strongestStage: reached, updatedAt: item.updatedAt };
		}
	}
	if (recorded) return { stage: profile.stage, recordedAt: profile.recordedAt, strongestStage, source: "profile" };
	if (selected && (selected.stage !== "not_applied" || strongestStage !== "not_applied")) {
		return { stage: selected.stage, recordedAt: selected.updatedAt.toISOString(), strongestStage, source: "application" };
	}
	return { stage: "not_applied", recordedAt: null, strongestStage, source: "none" };
}

export function reviewFreshness(
	profile: Pick<ResumeProfile, "reviewedResumeUpdatedAt" | "reviewedSourceUpdatedAt">,
	updatedAt: Date,
	sourceResumeId: string | null,
	sourceUpdatedAt: Date | null,
) {
	const sourceStale = sourceResumeId !== null && (
		!profile.reviewedSourceUpdatedAt || !sourceUpdatedAt ||
		Date.parse(profile.reviewedSourceUpdatedAt) !== sourceUpdatedAt.getTime()
	);
	const reviewStale = !profile.reviewedResumeUpdatedAt ||
		Date.parse(profile.reviewedResumeUpdatedAt) !== updatedAt.getTime() || sourceStale;
	return { reviewStale, sourceStale };
}

/** Reject stale snapshots instead of certifying that an assistant reviewed a version it never read. */
export function assertCurrentSnapshot(value: string | null | undefined, current: Date | null, subject: string) {
	if (value !== undefined && value !== null && (!current || Date.parse(value) !== current.getTime())) {
		throw new ORPCError("CONFLICT", { message: `${subject} changed. Read it again before saving its assessment or review.` });
	}
}

/** This is lexical reuse guidance, never a hiring probability or an AI-generated fit score. */
export function rankResume(
	entry: Omit<ResumeIndexEntry, "similarity" | "reusePriority" | "reuseHints">,
	input: MatchInput,
): ResumeIndexEntry {
	const hints: string[] = [];
	let points = 0;
	let maximum = 0;
	let relevantContent = false;
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
		relevantContent ||= [...wanted].some((word) => existing.has(word) && !genericRoleTerms.has(word));
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
		const content = tokens([entry.name, entry.targetRole, ...entry.keywords, ...entry.tags, entry.reuseNotes].join(" "));
		relevantContent ||= [...requested].some((word) => content.has(word) && !genericRoleTerms.has(word));
		points += (overlap.length / requested.size) * 40;
		if (overlap.length > 0) hints.push(`Shared terms: ${overlap.slice(0, 10).join(", ")}.`);
	}
	if (entry.purpose === "master") hints.push("Master resume: read this as factual source material; tailor a copy.");
	if (entry.evaluationStale) hints.push("Saved evaluation is out of date for this resume or job context; score it again.");
	if (entry.sourceResumeId) hints.push("Derived resume: check the source for newer experience before reusing.");
	if (entry.reviewStale) hints.push("Source or resume review is out of date; compare the current versions before reuse.");
	const similarity = maximum > 0 ? Math.round((points / maximum) * 100) : 0;
	const outcomeBonus = similarity >= 40 && relevantContent
		? ({ not_applied: 0, applied: 0, interview: 5, offer: 8 } as const)[entry.outcome.strongestStage]
		: 0;
	if (outcomeBonus > 0) hints.push(`Recorded ${entry.outcome.strongestStage} outcome adds a small reuse preference; it does not prove the resume caused the result.`);
	return { ...entry, similarity, reusePriority: Math.min(100, similarity + outcomeBonus), reuseHints: hints };
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
