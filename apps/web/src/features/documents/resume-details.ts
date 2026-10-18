import type { DocumentSummary } from "./filter";

export type ResumeDetailsValues = {
	folderId: string;
	sourceResumeId: string;
	companyId: string;
	purpose: "general" | "master" | "tailored";
	company: string;
	targetRole: string;
	keywords: string[];
	jobDescription: string;
	jobUrl: string;
	reuseNotes: string;
	score: string;
	scoreNotes: string;
};

/** Keep untouched agent metadata intact, including the timestamp of its last real assessment. */
export function changedResumeDetails(document: DocumentSummary, values: ResumeDetailsValues) {
	const initial = document.profile;
	const profile = {
		...(values.purpose !== (initial?.purpose ?? "general") ? { purpose: values.purpose } : {}),
		...(values.company.trim() !== (initial?.company ?? "") ? { company: values.company.trim() } : {}),
		...(values.targetRole.trim() !== (initial?.targetRole ?? "") ? { targetRole: values.targetRole.trim() } : {}),
		...(JSON.stringify(values.keywords) !== JSON.stringify(initial?.keywords ?? []) ? { keywords: values.keywords } : {}),
		...(values.jobDescription !== (initial?.jobDescription ?? "") ? { jobDescription: values.jobDescription } : {}),
		...(values.jobUrl.trim() !== (initial?.jobUrl ?? "") ? { jobUrl: values.jobUrl.trim() } : {}),
		...(values.reuseNotes !== (initial?.reuseNotes ?? "") ? { reuseNotes: values.reuseNotes } : {}),
		...(values.score !== (initial?.score?.toString() ?? "") || values.scoreNotes !== (initial?.scoreNotes ?? "")
			? { score: values.score === "" ? null : Number(values.score), scoreNotes: values.scoreNotes }
			: {}),
	};
	return {
		resumeId: document.id,
		...(values.folderId !== (document.folderId ?? "") ? { folderId: values.folderId || null } : {}),
		...(values.sourceResumeId !== (document.sourceResumeId ?? "")
			? { sourceResumeId: values.sourceResumeId || null }
			: {}),
		...(values.companyId !== (document.companyId ?? "") ? { companyId: values.companyId || null } : {}),
		...(Object.keys(profile).length > 0 ? { profile } : {}),
	};
}
