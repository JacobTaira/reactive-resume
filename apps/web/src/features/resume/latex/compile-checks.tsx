import type { LatexCompileChecks } from "@reactive-resume/schema/resume/latex";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";

type LatexPdfChecksProps = { checks: LatexCompileChecks | undefined; stale: boolean };

/** Compiler and text diagnostics help review a PDF; they do not establish visual or ATS quality. */
export function LatexPdfChecks({ checks, stale }: LatexPdfChecksProps) {
	if (!checks) return <section role="status" className="border-b border-line bg-warn-soft px-4 py-3 text-xs text-warn-text">
		<Trans>Automatic PDF checks are unavailable. Rebuild the LaTeX compiler service to enable them.</Trans>
	</section>;
	const hasWarning = checks.pageCount === null || checks.pageCountMatches === false || checks.overfullBoxes.count > 0 || checks.textExtraction.status !== "success";
	const count = checks.pageCount;
	const target = checks.expectedPageCount;
	const overflow = checks.overfullBoxes.count;
	const characters = checks.textExtraction.characterCount;
	return <section aria-label={t`PDF checks`} className={`shrink-0 border-b border-line px-4 py-3 ${hasWarning ? "bg-warn-soft" : "bg-surface"}`}>
		<div className="flex flex-wrap items-center justify-between gap-2 text-xs">
			<p className="font-semibold"><Trans>PDF checks</Trans></p>
			<span className={hasWarning ? "text-warn-text" : "text-accent-text"}>{hasWarning ? <Trans>Review warnings</Trans> : <Trans>No issues detected by these checks</Trans>}</span>
		</div>
		<ul className="mt-2 grid gap-1 text-xs text-ink-2">
			<li>{count === null ? <Trans>Page count unavailable.</Trans> : target === null ? <Trans>Pages: {count}. No page target set.</Trans> : <Trans>Pages: {count}. Target: {target}.</Trans>} {checks.pageCountMatches === false && <strong className="font-medium text-warn-text"><Trans>Page count differs from the target.</Trans></strong>}</li>
			<li>{overflow === 0 ? <Trans>No overfull box warnings in the compiler log.</Trans> : <Trans>Overfull box warnings: {overflow}. Check for content extending beyond its allotted space.</Trans>}</li>
			<li>{checks.textExtraction.status === "success" ? <Trans>Extracted characters: {characters}.</Trans> : checks.textExtraction.status === "empty" ? <Trans>No readable text was extracted.</Trans> : checks.textExtraction.status === "unavailable" ? <Trans>Text extraction is unavailable.</Trans> : <Trans>Text extraction failed.</Trans>}</li>
		</ul>
		{checks.overfullBoxes.messages.length > 0 && <details className="mt-2 text-xs text-ink-2"><summary className="cursor-pointer"><Trans>Show overflow details</Trans></summary><pre className="mt-2 max-h-28 overflow-auto font-mono text-[11px] whitespace-pre-wrap">{checks.overfullBoxes.messages.join("\n")}</pre>{checks.overfullBoxes.truncated && <p className="mt-1"><Trans>Only the first 20 warnings are shown.</Trans></p>}</details>}
		{stale && <p className="mt-2 text-xs font-medium text-warn-text"><Trans>These checks describe the last compilation.</Trans></p>}
		<p className="mt-2 text-[11px] leading-4 text-ink-3"><Trans>Checks use compiler warnings and extracted PDF text. Review the layout and text before submitting; these checks do not guarantee ATS compatibility.</Trans></p>
	</section>;
}
