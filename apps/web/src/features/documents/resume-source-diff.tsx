import type { RouterOutput } from "@/libs/orpc/client";
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "@reactive-resume/ui/components/button";
import { getOrpcErrorMessage } from "@/libs/error-message";
import { formatRelativeTime } from "@/libs/locale";
import { orpc } from "@/libs/orpc/client";

type ResumeComparison = RouterOutput["library"]["resumes"]["compare"];
type ComparisonFile = ResumeComparison["files"][number];
type ResumeSourceDiffProps = { resumeId: string; sourceResumeId: string | null };

/** Source content stays unloaded until this account explicitly opens the comparison. */
export function ResumeSourceDiff({ resumeId, sourceResumeId }: ResumeSourceDiffProps) {
	const { i18n } = useLingui();
	const id = useId();
	const [requested, setRequested] = useState(false);
	const comparison = useQuery({
		...orpc.library.resumes.compare.queryOptions({
			input: { resumeId, ...(sourceResumeId ? { sourceResumeId } : {}) },
		}),
		enabled: requested && Boolean(sourceResumeId),
	});
	const result = comparison.data;

	if (!sourceResumeId) {
		return (
			<p className="text-sm text-ink-3">
				<Trans>Choose a resume in “Based on resume” and save its details to compare the saved content.</Trans>
			</p>
		);
	}

	return (
		<section className="grid gap-3" aria-labelledby={`${id}-title`}>
			<div className="flex flex-wrap items-center justify-between gap-3">
				<h3 id={`${id}-title`} className="text-sm font-semibold">
					<Trans>Saved content comparison</Trans>
				</h3>
				<Button
					variant="secondary"
					size="sm"
					loading={requested && comparison.isFetching}
					onClick={() => {
						if (requested) void comparison.refetch();
						else setRequested(true);
					}}
				>
					{requested && comparison.isFetching ? (
						<Trans>Comparing…</Trans>
					) : requested ? (
						<Trans>Refresh comparison</Trans>
					) : (
						<Trans>Compare with source</Trans>
					)}
				</Button>
			</div>
			<p className="text-xs leading-5 text-ink-3">
				<Trans>Compare this resume with its source as saved now. The source may have changed since the copy was made; this is separate from the agent’s explanation of its edits.</Trans>
			</p>
			{requested && comparison.isPending && (
				<p role="status" className="text-sm text-ink-2">
					<Trans>Loading saved content…</Trans>
				</p>
			)}
			{requested && comparison.isError && (
				<div role="alert" className="grid justify-items-start gap-2 rounded-md border border-line p-3">
					<p className="text-sm text-danger-text">
						{getOrpcErrorMessage(comparison.error, { fallback: t`Couldn't compare these resumes. The source may have been removed or moved to Trash.` })}
					</p>
					<Button variant="secondary" size="sm" loading={comparison.isFetching} onClick={() => void comparison.refetch()}>
						<Trans>Try again</Trans>
					</Button>
				</div>
			)}
			{requested && result && !comparison.isError && (
				<div className="grid gap-3">
					<div className="grid gap-1 rounded-md bg-sunken p-3 text-xs text-ink-2">
						<p>
							<Trans>Source: {result.source.name} · Saved {formatRelativeTime(result.source.updatedAt, i18n.locale)}</Trans>
						</p>
						<p>
							<Trans>This resume: {result.target.name} · Saved {formatRelativeTime(result.target.updatedAt, i18n.locale)}</Trans>
						</p>
						{result.comparison !== "latex" && (
							<p>
								<Trans>Structured resume fields are shown as saved JSON; LaTeX resumes show their source files.</Trans>
							</p>
						)}
					</div>
					{result.identical ? (
						<p role="status" className="rounded-md bg-accent-soft p-3 text-sm text-accent-text">
							<Trans>The saved content is identical.</Trans>
						</p>
					) : (
						<div className="grid gap-3">
							<p className="text-xs text-ink-3">
								<Trans>− Removed from source · + Added in this resume</Trans>
							</p>
							{result.files.map((file) => <SourceDiffFile key={file.path} file={file} />)}
						</div>
					)}
					{result.truncated && (
						<p role="status" className="rounded-md bg-warn-soft p-3 text-xs leading-5 text-warn-text">
							<Trans>This comparison was shortened. Open the full source files before judging changes that are not shown here.</Trans>
						</p>
					)}
				</div>
			)}
		</section>
	);
}

type SourceDiffFileProps = { file: ComparisonFile };

function SourceDiffFile({ file }: SourceDiffFileProps) {
	const kind = file.kind === "added" ? t`Added file` : file.kind === "removed" ? t`Removed file` : t`Modified file`;
	return (
		<details open className="min-w-0 overflow-hidden rounded-md border border-line">
			<summary className="cursor-pointer bg-sunken px-3 py-2 text-xs text-ink-2">
				<span className="font-mono break-all">{file.path}</span>
				<span className="ms-2">{kind} · +{file.addedLines} / −{file.removedLines}</span>
			</summary>
			{file.binary ? (
				<p className="p-3 text-xs text-ink-3">
					<Trans>This supporting file is binary, so its contents cannot be shown as text.</Trans>
				</p>
			) : (
				<div className="max-h-80 overflow-auto">
					<table className="w-full border-collapse font-mono text-xs">
						<caption className="sr-only">{file.path}</caption>
						<thead className="sr-only">
							<tr>
								<th scope="col"><Trans>Source line</Trans></th>
								<th scope="col"><Trans>Resume line</Trans></th>
								<th scope="col"><Trans>Change</Trans></th>
								<th scope="col"><Trans>Saved content</Trans></th>
							</tr>
						</thead>
						<tbody>
							{file.lines.map((line, index) => (
								<tr
									key={`${line.oldLine}:${line.newLine}:${index}`}
									className={line.kind === "added" ? "bg-accent-soft text-accent-text" : line.kind === "removed" ? "bg-danger-soft text-danger-text" : "text-ink-2"}
								>
									<td className="w-9 px-1.5 align-top text-end text-ink-3 select-none">{line.oldLine}</td>
									<td className="w-9 px-1.5 align-top text-end text-ink-3 select-none">{line.newLine}</td>
									<td className="w-5 align-top text-center">
										<span className="sr-only">{line.kind === "added" ? t`Added` : line.kind === "removed" ? t`Removed` : t`Unchanged`}</span>
										<span aria-hidden>{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}</span>
									</td>
									<td className="min-w-0 px-2 align-top">
										<pre className="whitespace-pre-wrap break-all">{line.text || " "}</pre>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
			{(file.coarse || file.truncated) && (
				<p className="border-t border-line p-3 text-xs leading-5 text-ink-3">
					<Trans>Large changes are shown as simplified blocks or shortened text. Review the full file for complete detail.</Trans>
				</p>
			)}
		</details>
	);
}
