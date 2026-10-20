import type { LatexProject } from "@reactive-resume/schema/resume/latex";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { latexProjectSchema, LATEX_LIMITS } from "@reactive-resume/schema/resume/latex";
import { Button } from "@reactive-resume/ui/components/button";
import { Icon } from "@reactive-resume/ui/components/icon";
import { toast } from "@reactive-resume/ui/components/toast";
import { downloadWithAnchor } from "@reactive-resume/utils/file";
import { LatexCodeEditor } from "./code-editor";
import { LatexPdfChecks } from "./compile-checks";
import { base64Bytes, projectArchive } from "./files";
import { LatexSplitPanes } from "./split-panes";
import { useCurrentResume, useResumeStore, useUpdateResumeData } from "@/features/resume/builder/draft";
import { BackLink } from "@/features/resume/editor/chrome";
import { useEditorStore } from "@/features/resume/editor/store";
import { HistoryTab } from "@/features/resume/share/history-tab";
import { DocumentMenu } from "@/routes/builder/$resumeId/-components/document-menu";
import { client, orpc } from "@/libs/orpc/client";

const route = getRouteApi("/builder/$resumeId");

/** The original dashboard, draft synchronization and versions, with a source-first editor. */
export function LatexWorkspace() {
	const resume = useCurrentResume();
	const historyId = useEditorStore((state) => state.historyVersionId);
	const [historyOpen, setHistoryOpen] = useState(false);
	const { version: versionFromUrl } = route.useSearch();
	const navigate = route.useNavigate();
	const { data: version, isError } = useQuery({
		...orpc.resume.getVersion.queryOptions({ input: { resumeId: resume.id, versionId: historyId ?? "" } }),
		enabled: historyId !== null,
	});
	useEffect(() => {
		if (!versionFromUrl) return;
		useEditorStore.getState().setHistoryVersion(versionFromUrl);
		void navigate({ to: ".", replace: true, search: (previous) => ({ ...previous, version: undefined }) });
	}, [navigate, versionFromUrl]);
	useEffect(() => () => useEditorStore.getState().reset(), []);

	const project = historyId ? version?.data.latex : resume.data.latex;
	return (
		<div className="flex h-svh flex-col overflow-hidden bg-bg">
			<header className="flex min-h-16 flex-wrap items-center gap-3 border-b border-line bg-surface px-4 py-2">
				<BackLink />
				<div className="grid min-w-0 flex-1"><DocumentMenu /></div>
				<span className="rounded-md bg-accent-soft px-2 py-1 font-mono text-xs text-accent-text">LaTeX · PDFLaTeX</span>
				<Button variant="secondary" onClick={() => setHistoryOpen(!historyOpen)} aria-expanded={historyOpen}>
					<Icon name="clock-counter-clockwise" /><Trans>History</Trans>
				</Button>
			</header>
			{historyId && <div role="status" className="flex items-center justify-between gap-3 bg-accent-soft px-4 py-2 text-sm">
				<span><Trans>Viewing a saved version. Editing is disabled.</Trans></span>
				<Button variant="ghost" size="sm" onClick={() => useEditorStore.getState().setHistoryVersion(null)}><Trans>Back to current</Trans></Button>
			</div>}
			<div className="flex min-h-0 flex-1 flex-col lg:flex-row">
				{project ? <LatexDocument key={`${resume.id}:${historyId ?? "current"}`} project={project} readOnly={resume.isLocked || historyId !== null} /> :
					<p className="p-6" role="status">{isError ? <Trans>Could not load this version.</Trans> : historyId && !version ? <Trans>Loading version…</Trans> : <Trans>This version has no LaTeX source. Restore it from History to open its original editor.</Trans>}</p>}
				{historyOpen && <aside aria-label={t`Version history`} className="max-h-[40vh] overflow-y-auto border-t border-line bg-surface p-4 lg:max-h-none lg:w-96 lg:shrink-0 lg:border-s lg:border-t-0"><HistoryTab /></aside>}
			</div>
		</div>
	);
}

type LatexDocumentProps = { project: LatexProject; readOnly: boolean };

function LatexDocument({ project, readOnly }: LatexDocumentProps) {
	const resume = useCurrentResume();
	const expectedPagesKey = `reactive-resume:latex-expected-pages:${resume.id}`;
	const [expectedPages, setExpectedPages] = useState(() => {
		try {
			const saved = window.localStorage.getItem(expectedPagesKey) ?? "";
			return Number.isInteger(Number(saved)) && Number(saved) >= 1 && Number(saved) <= 100 ? saved : "";
		} catch { return ""; }
	});
	const validPageTarget = expectedPages === "" || Number.isInteger(Number(expectedPages)) && Number(expectedPages) >= 1 && Number(expectedPages) <= 100;
	const expectedPageCount = expectedPages !== "" && validPageTarget ? Number(expectedPages) : undefined;
	useEffect(() => {
		if (!validPageTarget) return;
		try { window.localStorage.setItem(expectedPagesKey, expectedPages); }
		catch { /* Page targets still work when browser storage is unavailable. */ }
	}, [expectedPages, expectedPagesKey, validPageTarget]);
	const update = useUpdateResumeData();
	const canUndo = useResumeStore((state) => state.canUndo);
	const canRedo = useResumeStore((state) => state.canRedo);
	const [selected, setSelected] = useState(project.entrypoint);
	const [requested, setRequested] = useState({ project, expectedPageCount });
	const [logOpen, setLogOpen] = useState(false);
	const [checksExpanded, setChecksExpanded] = useState(true);
	const [parserOpen, setParserOpen] = useState(false);
	const [parserText, setParserText] = useState("");
	const upload = useRef<HTMLInputElement>(null);
	const file = project.files.find((item) => item.path === selected) ?? project.files[0];
	const currentKey = JSON.stringify({ project, expectedPageCount });
	const requestedKey = JSON.stringify(requested);
	const stale = currentKey !== requestedKey;
	const result = useQuery({
		queryKey: ["latex-preview", resume.id, requestedKey],
		queryFn: () => client.resume.latex.render(requested),
		staleTime: Infinity, gcTime: 60_000, retry: false,
	});
	const blob = useMemo(() => result.data?.success ? new Blob([base64Bytes(result.data.pdf)], { type: "application/pdf" }) : undefined, [result.data]);
	const failed = result.isError || result.data?.success === false;
	const log = result.data?.log ?? (result.error instanceof Error ? result.error.message : "");

	const changeProject = (next: LatexProject, key?: string) => {
		if (readOnly) return;
		update((draft) => { draft.latex = next; }, key ? { coalesceKey: key } : { newStep: true });
	};
	const compile = () => {
		setParserOpen(false);
		setParserText("");
		if (currentKey === requestedKey) void result.refetch();
		else setRequested({ project: structuredClone(project), expectedPageCount });
	};
	const downloadPdf = () => { if (blob && !stale && !failed) downloadWithAnchor(blob, `${resume.name}.pdf`); };
	const showParser = async () => {
		if (!blob) return;
		if (result.data?.success && result.data.checks && ["success", "empty"].includes(result.data.checks.textExtraction.status)) {
			setParserText(result.data.checks.textExtraction.text);
			setParserOpen(true);
			return;
		}
		try {
			const { extractPdfLines } = await import("../import/pdf-text");
			const lines = await extractPdfLines(new File([blob], "resume.pdf", { type: "application/pdf" }));
			setParserText(lines.join("\n"));
			setParserOpen(true);
		} catch { toast.add({ type: "error", description: t`Could not extract text from this PDF.` }); }
	};
	const addFiles = async (files: FileList | null) => {
		if (!files || readOnly) return;
		try {
			const next = structuredClone(project);
			for (const added of Array.from(files)) {
				if (added.size > LATEX_LIMITS.fileBytes) throw new Error(t`Each file must be 2 MiB or smaller.`);
				const bytes = new Uint8Array(await added.arrayBuffer());
				let content: string;
				let encoding: "utf-8" | "base64";
				try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); encoding = "utf-8"; }
				catch { content = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join("")); encoding = "base64"; }
				const replacement = { path: added.name, content, encoding };
				const index = next.files.findIndex((item) => item.path === added.name);
				if (index < 0) next.files.push(replacement); else next.files[index] = replacement;
			}
			changeProject(latexProjectSchema.parse(next));
		} catch (error) { toast.add({ type: "error", description: error instanceof Error ? error.message : t`Could not add these files.` }); }
	};

	return <LatexSplitPanes source={
		<section aria-label={t`LaTeX source`} className="flex min-h-0 min-w-0 flex-1 flex-col">
			<div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
				<label className="flex items-center gap-2 text-xs"><Trans>File</Trans>
					<select aria-label={t`Project file`} value={file?.path ?? ""} onChange={(event) => setSelected(event.target.value)} className="max-w-64 rounded border border-line bg-surface p-1.5 text-sm">
						{project.files.map((item) => <option key={item.path} value={item.path}>{item.path}</option>)}
					</select>
				</label>
				<input ref={upload} type="file" multiple className="hidden" aria-label={t`Add project files`} onChange={(event) => { void addFiles(event.target.files); event.target.value = ""; }} />
				<Button variant="ghost" size="sm" disabled={readOnly} onClick={() => upload.current?.click()}><Trans>Add files</Trans></Button>
				<Button variant="ghost" size="sm" disabled={readOnly || !file || file.path === project.entrypoint} onClick={() => {
					if (!file) return;
					changeProject({ ...project, files: project.files.filter((item) => item.path !== file.path) });
					setSelected(project.entrypoint);
				}}><Trans>Remove file</Trans></Button>
			</div>
			<div className="flex items-center gap-2 border-b border-line px-3 py-2 text-xs text-ink-2">
				<label className="flex items-center gap-2"><Trans>Main document</Trans>
					<select value={project.entrypoint} disabled={readOnly} onChange={(event) => changeProject({ ...project, entrypoint: event.target.value })} className="rounded border border-line bg-surface p-1">
						{project.files.filter((item) => item.path.toLowerCase().endsWith(".tex")).map((item) => <option key={item.path} value={item.path}>{item.path}</option>)}
					</select>
				</label>
				<span className="ms-auto"><Trans>Changes save automatically</Trans></span>
			</div>
			<div className="min-h-0 flex-1">{file?.encoding === "utf-8" ?
				<LatexCodeEditor key={file.path} label={t`LaTeX source: ${file.path}`} value={file.content} readOnly={readOnly} onChange={(content) => changeProject({ ...project, files: project.files.map((item) => item.path === file.path ? { ...item, content } : item) }, `latex:${file.path}`)} /> :
				<p className="p-6 text-sm text-ink-2"><Trans>Binary asset. It is preserved in the project and included in source exports.</Trans></p>}
			</div>
			<div className="flex flex-wrap items-center gap-2 border-t border-line p-3">
				<Button variant="secondary" onClick={() => downloadWithAnchor(projectArchive(project), `${resume.name}-source.zip`)}><Trans>Download source ZIP</Trans></Button>
				<Button variant="ghost" disabled={!file} onClick={() => { if (file) downloadWithAnchor(new Blob([file.encoding === "utf-8" ? file.content : base64Bytes(file.content)]), file.path.split("/").at(-1) ?? "source.tex"); }}><Trans>Download file</Trans></Button>
				<Button variant="ghost" disabled={readOnly || !canUndo} onClick={() => useResumeStore.getState().undo()}><Trans>Undo</Trans></Button>
				<Button variant="ghost" disabled={readOnly || !canRedo} onClick={() => useResumeStore.getState().redo()}><Trans>Redo</Trans></Button>
			</div>
		</section>
	} preview={
		<section aria-label={t`Compiled PDF`} className="flex min-h-0 min-w-0 flex-1 flex-col bg-sunken">
			<div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface p-3">
				<Button onClick={compile} disabled={result.isFetching || !validPageTarget}>{result.isFetching ? <Trans>Compiling…</Trans> : <Trans>Compile PDF</Trans>}</Button>
				<Button variant="secondary" disabled={!blob || stale || failed || result.isFetching} onClick={downloadPdf}><Trans>Download PDF</Trans></Button>
				<Button variant="ghost" disabled={!blob || stale || failed} onClick={() => void showParser()}><Trans>Read extracted text</Trans></Button>
				<Button variant="ghost" onClick={() => setLogOpen(!logOpen)} aria-expanded={logOpen}><Trans>Compiler log</Trans></Button>
				<label className="flex items-center gap-2 text-xs text-ink-2"><Trans>Expected pages</Trans><input type="number" min={1} max={100} step={1} value={expectedPages} aria-invalid={!validPageTarget} placeholder="—" title={t`Leave blank to report page count without a target.`} className="w-16 rounded border border-line bg-raised px-2 py-1.5 text-sm text-ink" onChange={(event) => setExpectedPages(event.target.value)} /></label>
				{!validPageTarget && <p role="alert" className="text-xs text-danger-text"><Trans>Use a page target from 1 to 100, or leave it blank.</Trans></p>}
			</div>
			{stale && <p role="status" className="border-b border-line bg-accent-soft px-4 py-2 text-sm"><Trans>Source or page target changed. Compile again to refresh the PDF checks.</Trans></p>}
			{result.data?.success && !failed && <LatexPdfChecks checks={result.data.checks} stale={stale} expanded={checksExpanded} onExpandedChange={setChecksExpanded} />}
			{failed && <p role="alert" className="bg-danger-soft px-4 py-3 text-sm text-danger-text"><Trans>Compilation failed. Check the compiler log below.</Trans></p>}
			{(logOpen || failed) && <pre className="max-h-52 shrink-0 overflow-auto border-b border-line p-3 font-mono text-xs whitespace-pre-wrap" aria-label={t`Compiler output`}>{log}</pre>}
			{parserOpen && <div className="max-h-64 shrink-0 overflow-auto border-b border-line bg-surface p-4"><Button variant="ghost" size="sm" onClick={() => setParserOpen(false)}><Trans>Close extracted text</Trans></Button>{result.data?.success && result.data.checks?.textExtraction.truncated && <p className="mt-2 text-xs text-ink-3"><Trans>The extracted text shown is limited to 50,000 characters.</Trans></p>}<pre className="mt-2 text-xs whitespace-pre-wrap">{parserText}</pre></div>}
			{blob && !failed ? <CompiledPdf blob={blob} /> : !failed && <p role="status" className="p-6 text-sm text-ink-2"><Trans>Preparing PDF preview…</Trans></p>}
		</section>
	} />;
}

type CompiledPdfProps = { blob: Blob };

function CompiledPdf({ blob }: CompiledPdfProps) {
	const [url, setUrl] = useState<string>();
	useEffect(() => {
		const next = URL.createObjectURL(blob);
		// oxlint-disable-next-line react/set-state-in-effect -- blob URLs are resources created and revoked with this effect.
		setUrl(next);
		return () => URL.revokeObjectURL(next);
	}, [blob]);
	return url ? <iframe title={t`Compiled resume PDF`} src={url} className="min-h-0 w-full flex-1 border-0" /> : null;
}
