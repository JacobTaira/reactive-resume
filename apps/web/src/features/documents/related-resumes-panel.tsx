import type { DocumentSummary } from "./filter";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button } from "@reactive-resume/ui/components/button";
import { Skeleton } from "@reactive-resume/ui/components/skeleton";
import { outcomeStageLabel } from "./resume-outcome";
import { buildRelatedResumeQuery, selectRelatedResumes } from "./resume-review";
import { orpc } from "@/libs/orpc/client";

type RelatedResumesPanelProps = { document: DocumentSummary };

/** Search the saved job metadata only when a target is available. Full resume source stays unopened. */
export function RelatedResumesPanel({ document }: RelatedResumesPanelProps) {
	const input = buildRelatedResumeQuery(document.profile);
	const index = useQuery({
		...orpc.library.resumes.index.queryOptions({ input: input ?? { limit: 30 } }),
		enabled: input !== null,
	});
	const related = selectRelatedResumes(index.data ?? [], document.id);

	return (
		<section className="grid gap-4" aria-label={t`Related resumes`}>
			<div className="grid gap-1">
				<h3 className="font-semibold"><Trans>Reuse a related resume</Trans></h3>
				<p className="text-xs leading-5 text-ink-3">
					<Trans>Suggestions use this resume's saved company, role, and keywords. Recorded outcomes can add a small reuse preference. Check the review and source warnings before reusing content.</Trans>
				</p>
			</div>
			{input === null ? (
				<p className="rounded-lg border border-dashed border-line-2 p-4 text-sm text-ink-2">
					<Trans>Add a company, target role, or keywords in Details, then save to find related resumes.</Trans>
				</p>
			) : index.isPending ? (
				<div className="grid gap-3" aria-label={t`Loading related resumes`}>
					<Skeleton className="h-28 rounded-lg" />
					<Skeleton className="h-28 rounded-lg" />
				</div>
			) : index.isError ? (
				<div role="alert" className="grid justify-items-start gap-3 rounded-lg border border-line p-4">
					<p className="text-sm text-danger-text"><Trans>Couldn't load related resumes.</Trans></p>
					<Button variant="secondary" loading={index.isFetching} onClick={() => void index.refetch()}><Trans>Try again</Trans></Button>
				</div>
			) : related.length === 0 ? (
				<p className="rounded-lg border border-dashed border-line-2 p-4 text-sm text-ink-2">
					<Trans>No related resumes matched this saved target yet. Your agent can still start from your master resume.</Trans>
				</p>
			) : (
				<ul className="grid gap-3">
					{related.map((resume) => (
						<li key={resume.id} className="grid gap-3 rounded-lg border border-line bg-raised p-4">
							<div className="flex flex-wrap items-start justify-between gap-2">
								<div className="grid min-w-0 gap-1">
									<Link to="/builder/$resumeId" params={{ resumeId: resume.id }} target="_blank" rel="noopener noreferrer" className="text-sm font-semibold text-accent-text underline underline-offset-2">
										{resume.name}
										<span className="sr-only"> · <Trans>Opens in a new tab</Trans></span>
									</Link>
									<p className="text-xs text-ink-2">{[resume.company, resume.targetRole].filter(Boolean).join(" · ")}</p>
								</div>
								<span className="rounded bg-sunken px-2 py-1 text-xs"><Trans>Reuse priority {resume.reusePriority}/100</Trans></span>
							</div>
							<div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-2">
								<span><Trans>Metadata match {resume.similarity}/100</Trans></span>
								<span>{outcomeStageLabel(resume.outcome.stage)}</span>
								{resume.outcome.strongestStage !== "not_applied" && resume.outcome.strongestStage !== resume.outcome.stage && (
									<span><Trans>Reached: {outcomeStageLabel(resume.outcome.strongestStage)}</Trans></span>
								)}
								{resume.outcome.source === "application" && <span><Trans>Outcome from linked application</Trans></span>}
								{resume.reviewStale && <span><Trans>Review needs updating</Trans></span>}
								{resume.sourceStale && <span><Trans>Source needs comparison</Trans></span>}
							</div>
							{resume.reuseNotes && <p className="line-clamp-3 text-xs leading-5 text-ink-3">{resume.reuseNotes}</p>}
							{resume.keywords.length > 0 && <p className="line-clamp-2 text-xs text-ink-3">{resume.keywords.join(" · ")}</p>}
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
