import type { DocumentSummary } from "./filter";
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { getResumeReviewFreshness } from "./resume-review";
import { ResumeSourceDiff } from "./resume-source-diff";

type ResumeReviewPanelProps = { document: DocumentSummary; documents: DocumentSummary[] };

export function ResumeReviewPanel({ document, documents }: ResumeReviewPanelProps) {
	const { i18n } = useLingui();
	const profile = document.profile;
	const source = documents.find((candidate) => candidate.type === "resume" && candidate.id === document.sourceResumeId);
	const freshness = getResumeReviewFreshness({
		profile,
		updatedAt: document.updatedAt,
		sourceResumeId: document.sourceResumeId,
		...(source ? { sourceUpdatedAt: source.updatedAt } : {}),
	});
	const requirements = profile?.requirementEvidence ?? [];
	const changes = profile?.tailoringChanges ?? [];
	const statuses = { supported: t`Supported`, partial: t`Partial support`, gap: t`Gap` };
	const importance = { required: t`Required`, preferred: t`Preferred` };

	return (
		<div className="grid gap-6">
			<div className="grid gap-2 rounded-lg border border-line bg-sunken p-4 text-sm" role="status">
				{!freshness.reviewed ? (
					<p><Trans>A review has not been recorded for this version.</Trans></p>
				) : freshness.reviewStale ? (
					<p><Trans>This review is out of date. Ask Claude to review the current resume before relying on it.</Trans></p>
				) : (
					<p>{document.sourceResumeId
						? <Trans>This review matches the current saved resume and its source.</Trans>
						: <Trans>This review matches the current saved resume.</Trans>}</p>
				)}
				{freshness.sourceStale && (
					<p className="text-xs text-ink-2">
						<Trans>The source resume needs another comparison before this review can be treated as current.</Trans>
					</p>
				)}
				{profile?.reviewedResumeUpdatedAt && (
					<p className="text-xs text-ink-3">
						<Trans>Reviewed resume version: {new Date(profile.reviewedResumeUpdatedAt).toLocaleString(i18n.locale)}</Trans>
					</p>
				)}
				{document.sourceResumeId && profile?.reviewedSourceUpdatedAt && (
					<p className="text-xs text-ink-3">
						<Trans>Reviewed source version: {new Date(profile.reviewedSourceUpdatedAt).toLocaleString(i18n.locale)}</Trans>
					</p>
				)}
			</div>

			<section className="grid min-w-0 gap-3" aria-label={t`Requirement evidence`}>
				<div className="grid gap-1">
					<h3 className="font-semibold"><Trans>Requirement evidence</Trans></h3>
					<p className="text-xs leading-5 text-ink-3">
						<Trans>These requirements and supporting quotes were recorded by your agent. Review the evidence against your source resumes before submitting.</Trans>
					</p>
				</div>
				{requirements.length === 0 ? (
					<p className="rounded-lg border border-dashed border-line-2 p-4 text-sm text-ink-2">
						<Trans>No requirement evidence yet. Ask Claude to map the job requirements to evidence from your resumes.</Trans>
					</p>
				) : (
					<div className="overflow-x-auto rounded-lg border border-line">
						<table className="w-full min-w-[560px] table-fixed border-collapse text-sm">
							<caption className="sr-only"><Trans>Job requirements and resume evidence</Trans></caption>
							<thead className="bg-sunken text-start text-xs text-ink-2">
								<tr>
									<th scope="col" className="w-[34%] px-3 py-2 text-start font-medium"><Trans>Requirement</Trans></th>
									<th scope="col" className="w-28 px-3 py-2 text-start font-medium"><Trans>Support</Trans></th>
									<th scope="col" className="px-3 py-2 text-start font-medium"><Trans>Evidence and notes</Trans></th>
								</tr>
							</thead>
							<tbody>
								{requirements.map((requirement, index) => (
									<tr key={`${index}-${requirement.requirement}`} className="border-t border-line align-top">
										<th scope="row" className="px-3 py-3 text-start font-normal wrap-anywhere">
											<div className="grid gap-1"><span>{requirement.requirement}</span>
											<span className="text-xs text-ink-3">{importance[requirement.importance]}</span></div>
										</th>
										<td className="px-3 py-3">
											<span className={requirement.status === "gap" ? "text-danger-text" : "text-ink-2"}>
												{statuses[requirement.status]}
											</span>
										</td>
										<td className="space-y-3 px-3 py-3 wrap-anywhere">
											{requirement.evidence.map((evidence, evidenceIndex) => {
												const resume = documents.find((candidate) => candidate.type === "resume" && candidate.id === evidence.resumeId);
												return (
													<div key={`${evidenceIndex}-${evidence.resumeId}`} className="grid gap-1">
														{resume ? (
															<Link to="/builder/$resumeId" params={{ resumeId: resume.id }} target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-accent-text underline underline-offset-2">
																{resume.name}
															</Link>
														) : <span className="text-xs text-ink-3"><Trans>Source resume unavailable</Trans></span>}
														<code className="text-[11px] text-ink-3">{evidence.locator}</code>
														<blockquote className="border-s-2 border-line-2 ps-2 text-xs leading-5 whitespace-pre-wrap">{evidence.quote}</blockquote>
													</div>
												);
											})}
											{requirement.evidence.length === 0 && <p className="text-xs text-ink-3"><Trans>No supporting evidence recorded.</Trans></p>}
											{requirement.notes && <p className="text-xs leading-5 whitespace-pre-wrap text-ink-2">{requirement.notes}</p>}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</section>

			<section className="grid gap-3" aria-label={t`Agent-recorded tailoring changes`}>
				<h3 className="font-semibold"><Trans>Agent-recorded tailoring changes</Trans></h3>
				<p className="text-xs leading-5 text-ink-3">
					<Trans>Your agent's explanation of its edits. Use Compare with source below to inspect the actual saved content differences.</Trans>
				</p>
				{changes.length === 0 ? (
					<p className="rounded-lg border border-dashed border-line-2 p-4 text-sm text-ink-2"><Trans>No tailoring changes recorded yet.</Trans></p>
				) : changes.map((change, index) => (
					<details key={`${index}-${change.section}`} className="rounded-lg border border-line p-3">
						<summary className="cursor-pointer text-sm font-medium">{change.section}</summary>
						<div className="mt-3 grid gap-3">
							<div className="grid gap-3 sm:grid-cols-2">
								<div className="grid content-start gap-1"><h4 className="text-xs font-medium text-ink-2"><Trans>Before</Trans></h4><pre className="max-h-64 overflow-auto rounded bg-sunken p-3 font-mono text-xs leading-5 whitespace-pre-wrap wrap-anywhere">{change.before || t`Empty`}</pre></div>
								<div className="grid content-start gap-1"><h4 className="text-xs font-medium text-ink-2"><Trans>After</Trans></h4><pre className="max-h-64 overflow-auto rounded bg-sunken p-3 font-mono text-xs leading-5 whitespace-pre-wrap wrap-anywhere">{change.after || t`Empty`}</pre></div>
							</div>
							<p className="text-sm leading-5 whitespace-pre-wrap"><span className="font-medium"><Trans>Reason:</Trans> </span>{change.reason}</p>
						</div>
					</details>
				))}
			</section>
			<ResumeSourceDiff resumeId={document.id} sourceResumeId={document.sourceResumeId} />
		</div>
	);
}
