import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@reactive-resume/ui/components/button";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@reactive-resume/ui/components/sheet";
import { Skeleton } from "@reactive-resume/ui/components/skeleton";
import { createExportFile } from "@/features/resume/export/use-resume-export";
import { getOrpcErrorMessage } from "@/libs/error-message";
import { client, orpc } from "@/libs/orpc/client";
import { createReviewPdf, ReviewPdfError } from "./queue-review-pdf";

type QueueReviewSheetProps = {
	id: string;
	onClose: () => void;
	onPrevious?: (() => void) | undefined;
	onNext?: (() => void) | undefined;
};

/** Review the PDF, saved posting and actual source changes without changing application status. */
export function QueueReviewSheet({ id, onClose, onPrevious, onNext }: QueueReviewSheetProps) {
	const job = useQuery(orpc.applications.queue.read.queryOptions({ input: { id, includeDescription: true } }));
	const draftId = job.data?.preparation.draftResumeId ?? "";
	const resume = useQuery({ ...orpc.resume.getById.queryOptions({ input: { id: draftId } }), enabled: Boolean(draftId) });
	const metadata = useQuery({
		...orpc.library.resumes.getMetadata.queryOptions({ input: { resumeId: draftId } }),
		enabled: Boolean(draftId),
	});
	const comparison = useQuery({
		...orpc.library.resumes.compare.queryOptions({ input: { resumeId: draftId } }),
		enabled: Boolean(draftId && metadata.data?.sourceResumeId),
	});
	const pdf = useQuery({
		queryKey: ["queue-review-pdf", id, draftId, resume.data?.updatedAt.toISOString()],
		enabled: Boolean(resume.data),
		staleTime: Infinity,
		retry: false,
		queryFn: async () => {
			if (!resume.data) throw new Error("Missing resume snapshot");
			return createReviewPdf(resume.data, id, {
				compile: client.resume.latex.compile,
				read: client.resume.getById,
				render: (snapshot) => createExportFile(snapshot, "pdf"),
			});
		},
	});
	const blob = pdf.data?.blob;
	const [preview, setPreview] = useState<{ blob: Blob; url: string } | null>(null);
	useEffect(() => {
		if (!blob) return;
		const url = URL.createObjectURL(blob);
		setPreview({ blob, url });
		return () => URL.revokeObjectURL(url);
	}, [blob]);
	// Changing jobs or versions must never expose the previous packet's PDF while the next one loads.
	const previewUrl = preview?.blob === blob ? preview?.url : undefined;
	const checks = pdf.data?.checks;
	const comparisonCurrent = comparison.data?.target.updatedAt.getTime() === resume.data?.updatedAt.getTime();
	const gaps = metadata.data?.profile.requirementEvidence.filter((entry) => entry.status !== "supported") ?? [];
	const fileName = `${(resume.data?.name || "Resume").replace(/[\\/:*?"<>|]/g, "").trim() || "Resume"}.pdf`;

	const refresh = async () => {
		await job.refetch();
		if (!draftId) return;
		const [freshResume, freshMetadata] = await Promise.all([resume.refetch(), metadata.refetch()]);
		if (freshMetadata.data?.sourceResumeId) await comparison.refetch();
		// A new timestamp starts a new query automatically. Retry this query only for the same snapshot.
		if (freshResume.data?.updatedAt.getTime() === resume.data?.updatedAt.getTime()) await pdf.refetch();
	};

	return (
		<Sheet open onOpenChange={(open) => !open && onClose()}>
			<SheetContent side="right" closeLabel={t`Close`} className="w-full data-[side=right]:sm:max-w-[min(96vw,1360px)]">
				<SheetHeader>
					<SheetTitle>{job.data ? `${job.data.company} — ${job.data.role}` : <Trans>Review prepared resume</Trans>}</SheetTitle>
					<SheetDescription>
						<Trans>Review the exact PDF and saved posting. Ready for review does not mean submitted.</Trans>
					</SheetDescription>
				</SheetHeader>
				<div className="flex flex-wrap items-center gap-2 border-b border-line px-6 pb-4">
					<Button size="sm" variant="secondary" disabled={!onPrevious} onClick={onPrevious}>
						<Trans>Previous resume</Trans>
					</Button>
					<Button size="sm" variant="secondary" disabled={!onNext} onClick={onNext}>
						<Trans>Next resume</Trans>
					</Button>
					<Button size="sm" variant="ghost" disabled={job.isFetching || resume.isFetching || pdf.isFetching} onClick={() => void refresh()}>
						<Trans>Refresh current draft</Trans>
					</Button>
					{draftId && (
						<Button size="sm" variant="secondary" render={<Link to="/builder/$resumeId" params={{ resumeId: draftId }} />}>
							<Trans>Edit resume</Trans>
						</Button>
					)}
					{job.data?.sourceUrl && (
						<a className="text-sm text-accent-text hover:underline" href={job.data.sourceUrl} target="_blank" rel="noopener noreferrer">
							<Trans>Open original application</Trans>
						</a>
					)}
				</div>
				{job.isPending ? <Skeleton className="mx-6 h-80" /> : job.isError ? (
					<p role="alert" className="px-6 text-danger-text">
						<Trans>Couldn't load this saved job. Use Refresh current draft to retry.</Trans>
					</p>
				) : (
					<div className="grid min-h-0 flex-1 gap-6 overflow-y-auto px-6 pb-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
						<section className="grid min-w-0 content-start gap-3" aria-label={t`Prepared PDF`}>
							<div className="flex flex-wrap items-center justify-between gap-2">
								<h3 className="font-semibold"><Trans>Prepared PDF</Trans></h3>
								{previewUrl && (
									<a className="text-sm text-accent-text hover:underline" href={previewUrl} download={fileName}>
										<Trans>Download reviewed PDF</Trans>
									</a>
								)}
							</div>
							{!draftId ? (
								<p className="text-sm text-ink-2"><Trans>This job has no linked draft yet.</Trans></p>
							) : resume.isError ? (
								<p role="alert" className="text-danger-text"><Trans>The linked draft could not be read. Refresh or open the application.</Trans></p>
							) : pdf.isError ? (
								<p role="alert" className="text-danger-text">{reviewPdfErrorMessage(pdf.error)}</p>
							) : !previewUrl ? <Skeleton className="h-[65svh]" /> : (
								<iframe title={t`Prepared resume PDF`} src={previewUrl} className="h-[70svh] min-h-96 w-full rounded-lg border border-line bg-white" />
							)}
							{pdf.data && (
								<p className="text-xs text-ink-3">
									<Trans>Saved draft version: {pdf.data.updatedAt.toLocaleString()}. The download contains this displayed PDF.</Trans>
								</p>
							)}
							{checks && (
								<p className="text-xs text-ink-2">
									<Trans>Pages: {checks.pageCount ?? "?"}. Overflow warnings: {checks.overfullBoxes.count}.</Trans>
								</p>
							)}
							{pdf.data && (!checks || checks.pageCount !== 1 || checks.textExtraction.status !== "success" || !checks.textExtraction.text.trim() || checks.overfullBoxes.count > 0) && (
								<p role="status" className="rounded-lg bg-warn-soft p-3 text-sm text-warn-text">
									<Trans>Review PDF diagnostics and layout before submitting. Missing checks remain unverified.</Trans>
								</p>
							)}
							{checks && (
								<details className="rounded-lg border border-line p-3">
									<summary className="cursor-pointer font-medium"><Trans>Extracted PDF text</Trans></summary>
									<p className="mt-3 text-sm whitespace-pre-wrap">{checks.textExtraction.text}</p>
								</details>
							)}
						</section>
						<div className="grid min-w-0 content-start gap-5">
							{(job.data.preparation.notes || job.data.preparation.error || gaps.length > 0) && (
								<section aria-label={t`Questions and concerns`} className="grid gap-2 rounded-lg bg-warn-soft p-4 text-sm text-warn-text">
									<h3 className="font-semibold"><Trans>Questions and concerns</Trans></h3>
									{job.data.preparation.notes && <p className="whitespace-pre-wrap">{job.data.preparation.notes}</p>}
									{job.data.preparation.error && <p className="whitespace-pre-wrap">{job.data.preparation.error}</p>}
									{gaps.map((gap) => <p key={gap.requirement}>{gap.requirement}{gap.notes ? ` — ${gap.notes}` : ""}</p>)}
								</section>
							)}
							<section aria-label={t`Saved job description`} className="grid gap-2">
								<h3 className="font-semibold"><Trans>Saved job description</Trans></h3>
								{(job.data.truncated || job.data.contentWarning) && (
									<p className="text-sm text-warn-text"><Trans>The saved posting may be incomplete. Check the original application.</Trans></p>
								)}
								<p className="max-h-[55svh] overflow-y-auto rounded-lg border border-line p-4 text-sm leading-6 whitespace-pre-wrap">
									{job.data.description || t`No description was saved.`}
								</p>
							</section>
							<details className="rounded-lg border border-line p-3">
								<summary className="cursor-pointer font-semibold"><Trans>Changes from source resume</Trans></summary>
								<p className="mt-2 text-xs text-ink-3"><Trans>Compared with the source's current saved content. This is a source diff, not a factual verification.</Trans></p>
								{metadata.isError || comparison.isError ? (
									<p role="status" className="mt-3 text-sm text-warn-text"><Trans>Source comparison is unavailable. Review the PDF and background directly.</Trans></p>
								) : metadata.isPending ? <Skeleton className="mt-3 h-24" /> : !metadata.data?.sourceResumeId ? (
									<p className="mt-3 text-sm text-ink-2"><Trans>No source resume is linked.</Trans></p>
								) : comparison.isPending ? <Skeleton className="mt-3 h-24" /> : !comparisonCurrent ? (
									<p role="status" className="mt-3 text-sm text-warn-text"><Trans>The draft changed since this comparison. Refresh before reviewing changes.</Trans></p>
								) : comparison.data && (
									<div className="mt-3 grid gap-3">
										{comparison.data.identical && <p className="text-sm"><Trans>No source changes.</Trans></p>}
										{comparison.data.truncated && <p className="text-sm text-warn-text"><Trans>The comparison is shortened. Open the editor for full source.</Trans></p>}
										{comparison.data.files.map((file) => (
											<div key={file.path} className="grid gap-1">
												<p className="text-xs font-medium">{file.path}</p>
												{file.binary ? <p className="text-xs text-ink-3"><Trans>Binary file changed.</Trans></p> : (
													<pre className="max-h-72 overflow-auto rounded bg-sunken p-2 text-xs">
														{file.lines.map((line, index) => (
															<span key={`${line.oldLine}-${line.newLine}-${index}`} className={line.kind === "added" ? "block bg-accent-soft text-accent-text" : line.kind === "removed" ? "block bg-warn-soft text-warn-text" : "block text-ink-3"}>
																{line.kind === "added" ? "+ " : line.kind === "removed" ? "− " : "  "}{line.text}
															</span>
														))}
													</pre>
												)}
											</div>
										))}
									</div>
								)}
							</details>
						</div>
					</div>
				)}
			</SheetContent>
		</Sheet>
	);
}

function reviewPdfErrorMessage(error: unknown) {
	if (error instanceof ReviewPdfError) {
		if (error.reason === "changed") return t`The draft changed while its PDF was prepared. Refresh to review the current version.`;
		if (error.reason === "link") return t`This draft is no longer linked to this job. Refresh the queue before continuing.`;
		if (error.reason === "compile") return t`The PDF could not be compiled. Open the resume editor to inspect its errors.`;
		return t`The server did not return a valid PDF. Refresh or open the resume editor.`;
	}
	return getOrpcErrorMessage(error, { fallback: t`Couldn't prepare this PDF. Refresh to try again.` });
}
