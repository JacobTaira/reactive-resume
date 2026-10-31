import type { ResumeData } from "@reactive-resume/schema/resume/data";
import type { LatexCompileChecks } from "@reactive-resume/schema/resume/latex";

export type ReviewResumeSnapshot = {
	id: string;
	name: string;
	slug: string;
	updatedAt: Date;
	applicationId: string | null;
	data: ResumeData;
};

type CompileResult =
	| { success: true; pdf: string; checks?: LatexCompileChecks | undefined; resumeUpdatedAt: Date | null }
	| { success: false; log: string; resumeUpdatedAt: Date | null };

type ReviewPdfServices = {
	compile: (input: { id: string; expectedUpdatedAt: Date; expectedPageCount: number }) => Promise<CompileResult>;
	read: (input: { id: string }) => Promise<{ updatedAt: Date; applicationId: string | null }>;
	render: (resume: ReviewResumeSnapshot) => Promise<Blob>;
};

export class ReviewPdfError extends Error {
	readonly reason: "changed" | "link" | "compile" | "invalid-pdf";

	constructor(reason: ReviewPdfError["reason"]) {
		super(reason);
		this.reason = reason;
	}
}

/** A review/download uses one saved snapshot, never an arbitrary unsaved source or another job's draft. */
export async function createReviewPdf(
	resume: ReviewResumeSnapshot,
	applicationId: string,
	services: ReviewPdfServices,
) {
	if (resume.applicationId !== applicationId) throw new ReviewPdfError("link");
	let blob: Blob;
	let checks: LatexCompileChecks | undefined;
	if (resume.data.latex) {
		const compiled = await services.compile({ id: resume.id, expectedUpdatedAt: resume.updatedAt, expectedPageCount: 1 });
		if (!compiled.success) throw new ReviewPdfError("compile");
		if (compiled.resumeUpdatedAt?.getTime() !== resume.updatedAt.getTime()) throw new ReviewPdfError("changed");
		const content = atob(compiled.pdf);
		if (!content.startsWith("%PDF-")) throw new ReviewPdfError("invalid-pdf");
		blob = new Blob([Uint8Array.from(content, (character) => character.charCodeAt(0))], { type: "application/pdf" });
		checks = compiled.checks;
	} else {
		blob = await services.render(resume);
	}
	const current = await services.read({ id: resume.id });
	if (current.applicationId !== applicationId) throw new ReviewPdfError("link");
	if (current.updatedAt.getTime() !== resume.updatedAt.getTime()) throw new ReviewPdfError("changed");
	return { blob, checks, updatedAt: resume.updatedAt };
}
