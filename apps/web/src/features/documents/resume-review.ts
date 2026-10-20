type Timestamp = Date | string;

type ResumeReviewProfile = {
	reviewedResumeUpdatedAt?: string | null;
	reviewedSourceUpdatedAt?: string | null;
};

type ResumeReviewInput = {
	profile?: ResumeReviewProfile | null;
	updatedAt: Timestamp;
	sourceResumeId?: string | null;
	sourceUpdatedAt?: Timestamp | null;
};

const timestamp = (value: Timestamp) => (value instanceof Date ? value.getTime() : new Date(value).getTime());

/** A review covers its saved resume and source revisions; an unavailable source cannot be verified. */
export function getResumeReviewFreshness(input: ResumeReviewInput) {
	const reviewedAt = input.profile?.reviewedResumeUpdatedAt;
	const reviewedSourceAt = input.profile?.reviewedSourceUpdatedAt;
	const sourceStale = Boolean(
		input.sourceResumeId &&
			(!reviewedSourceAt ||
				!input.sourceUpdatedAt ||
				timestamp(reviewedSourceAt) !== timestamp(input.sourceUpdatedAt)),
	);
	return {
		reviewed: Boolean(reviewedAt),
		reviewStale: !reviewedAt || timestamp(reviewedAt) !== timestamp(input.updatedAt) || sourceStale,
		sourceStale,
	};
}

type RelatedResumeProfile = {
	company?: string;
	targetRole?: string;
	keywords?: readonly string[];
};

/** Skip an untargeted search so unrelated documents are never presented as suggested reuse. */
export function buildRelatedResumeQuery(profile: RelatedResumeProfile | null | undefined) {
	const company = profile?.company?.trim() ?? "";
	const targetRole = profile?.targetRole?.trim() ?? "";
	const seen = new Set<string>();
	const keywords = (profile?.keywords ?? []).map((keyword) => keyword.trim()).filter((keyword) => {
		const key = keyword.toLocaleLowerCase("en-US");
		if (!key || seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	if (!company && !targetRole && keywords.length === 0) return null;
	return {
		...(company ? { company } : {}),
		...(targetRole ? { targetRole } : {}),
		...(keywords.length > 0 ? { keywords } : {}),
		limit: 30,
	};
}

type RelatedResumeEntry = { id: string; similarity: number; reusePriority: number };

/** Outcome-based priority may order matches, but cannot turn an unrelated resume into a match. */
export function selectRelatedResumes<T extends RelatedResumeEntry>(
	entries: readonly T[],
	currentResumeId: string,
	limit = 5,
) {
	return entries
		.filter((entry) => entry.id !== currentResumeId && entry.similarity > 0)
		.sort((a, b) => b.reusePriority - a.reusePriority || b.similarity - a.similarity)
		.slice(0, Math.max(0, Math.min(5, Math.trunc(limit))));
}
