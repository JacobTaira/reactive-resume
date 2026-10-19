import type { DocumentSummary } from "./filter";
import type { OutcomeStage } from "./resume-outcome";
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "@reactive-resume/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@reactive-resume/ui/components/dialog";
import { Input } from "@reactive-resume/ui/components/input";
import { Label } from "@reactive-resume/ui/components/label";
import { NativeSelect } from "@reactive-resume/ui/components/native-select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@reactive-resume/ui/components/tabs";
import { toast } from "@reactive-resume/ui/components/toast";
import { LibraryField } from "./library-field";
import { folderPaths } from "./folders";
import { RelatedResumesPanel } from "./related-resumes-panel";
import { OUTCOME_STAGES, outcomeStageLabel } from "./resume-outcome";
import { ResumeReviewPanel } from "./resume-review-panel";
import { changedResumeDetails } from "./resume-details";
import { getOrpcErrorMessage } from "@/libs/error-message";
import { orpc } from "@/libs/orpc/client";

type ResumeDetailsDialogProps = { document: DocumentSummary | null; documents: DocumentSummary[]; onClose: () => void };

export function ResumeDetailsDialog({ document, documents, onClose }: ResumeDetailsDialogProps) {
	return <Dialog open={document !== null} onOpenChange={(open) => !open && onClose()}>
		{document && <ResumeDetailsForm key={document.id} document={document} documents={documents} onClose={onClose} />}
	</Dialog>;
}

type ResumeDetailsFormProps = { document: DocumentSummary; documents: DocumentSummary[]; onClose: () => void };

function ResumeDetailsForm({ document, documents, onClose }: ResumeDetailsFormProps) {
	const id = useId();
	const liveDocument = documents.find((candidate) => candidate.type === document.type && candidate.id === document.id) ?? document;
	const { i18n } = useLingui();
	const [section, setSection] = useState("details");
	const queryClient = useQueryClient();
	const folders = useQuery(orpc.library.folders.list.queryOptions({ input: {} }));
	const companies = useQuery(orpc.library.companies.list.queryOptions({ input: { limit: 100 } }));
	const [companyId, setCompanyId] = useState(document.companyId ?? "");
	const saveMetadata = useMutation(orpc.library.resumes.setMetadata.mutationOptions());
	const [folderId, setFolderId] = useState(document.folderId ?? "");
	const [sourceResumeId, setSourceResumeId] = useState(document.sourceResumeId ?? "");
	const [purpose, setPurpose] = useState<"general" | "master" | "tailored">(document.profile?.purpose ?? "general");
	const [company, setCompany] = useState(document.profile?.company ?? "");
	const [targetRole, setTargetRole] = useState(document.profile?.targetRole ?? "");
	const [keywords, setKeywords] = useState(document.profile?.keywords.join(", ") ?? "");
	const [jobDescription, setJobDescription] = useState(document.profile?.jobDescription ?? "");
	const [jobUrl, setJobUrl] = useState(document.profile?.jobUrl ?? "");
	const [reuseNotes, setReuseNotes] = useState(document.profile?.reuseNotes ?? "");
	const [score, setScore] = useState(document.profile?.score?.toString() ?? "");
	const [scoreNotes, setScoreNotes] = useState(document.profile?.scoreNotes ?? "");
	const [outcomeStage, setOutcomeStage] = useState<OutcomeStage>(document.profile?.outcome?.stage ?? "not_applied");
	const [outcomeNotes, setOutcomeNotes] = useState(document.profile?.outcome?.notes ?? "");
	const [error, setError] = useState<string | null>(null);

	const save = async () => {
		setError(null);
		const labels = document.profile && keywords === document.profile.keywords.join(", ")
			? document.profile.keywords
			: [...new Set(keywords.split(",").map((value) => value.trim()).filter(Boolean))];
		if (labels.length > 50 || labels.some((label) => label.length > 120)) {
			setError(t`Use up to 50 keywords, with no more than 120 characters each.`);
			return;
		}
		try {
			await saveMetadata.mutateAsync(changedResumeDetails(document, {
				folderId, sourceResumeId, companyId, purpose, company, targetRole, keywords: labels,
				jobDescription, jobUrl, reuseNotes, score, scoreNotes, outcomeStage, outcomeNotes,
			}));
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: orpc.documents.key() }),
				queryClient.invalidateQueries({ queryKey: orpc.library.key() }),
				queryClient.invalidateQueries({ queryKey: orpc.resume.key() }),
			]);
			toast.add({ description: t`Resume details saved` });
			onClose();
		} catch (cause) { setError(getOrpcErrorMessage(cause, { fallback: t`Couldn't save resume details. Try again.` })); }
	};

	return <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
		<form className="grid gap-5" onSubmit={(event) => { event.preventDefault(); void save(); }}>
			<DialogHeader>
				<DialogTitle>
					<Trans>Resume details</Trans>
				</DialogTitle>
				<DialogDescription>
					<Trans>Organize this resume and give Claude context to find, compare, and reuse it for related jobs.</Trans>
				</DialogDescription>
			</DialogHeader>
			<p className="truncate text-sm font-semibold">
				{document.name}
			</p>
			<Tabs value={section} onValueChange={(value) => setSection(value as string)}>
				<TabsList aria-label={t`Resume details section`}>
					<TabsTrigger value="details"><Trans>Details</Trans></TabsTrigger>
					<TabsTrigger value="review"><Trans>Review</Trans></TabsTrigger>
					<TabsTrigger value="related"><Trans>Related resumes</Trans></TabsTrigger>
				</TabsList>
				<TabsContent value="details" className="grid gap-5">
					<div className="grid gap-4 sm:grid-cols-2">
						<div className="grid gap-1.5">
							<Label htmlFor={`${id}-folder`}>
								<Trans>Folder</Trans>
							</Label>
							<NativeSelect
								id={`${id}-folder`}
								value={folderId}
								disabled={folders.isPending || folders.isError}
								onChange={(event) => setFolderId(event.target.value)}
							>
								<option value="">
									{t`Unfiled resumes`}
								</option>
								{folderPaths(folders.data ?? []).map((folder) => <option key={folder.id} value={folder.id}>
									{folder.path}
								</option>)}
							</NativeSelect>
							{folders.isError && <p role="alert" className="text-xs text-danger-text">
								<Trans>Couldn't load folders.</Trans>
								<button type="button" className="underline" onClick={() => void folders.refetch()}>
									<Trans>Try again</Trans>
								</button>
							</p>}
						</div>
						<div className="grid gap-1.5">
							<Label htmlFor={`${id}-purpose`}>
								<Trans>Resume purpose</Trans>
							</Label>
							<NativeSelect
								id={`${id}-purpose`}
								value={purpose}
								onChange={(event) => setPurpose(event.target.value as typeof purpose)}
							>
								<option value="general">
									{t`General resume`}
								</option>
								<option value="master">
									{t`Master resume`}
								</option>
								<option value="tailored">
									{t`Tailored for a job`}
								</option>
							</NativeSelect>
						</div>
						<LibraryField
							label={t`Company`}
							value={company}
							maxLength={200}
							onChange={setCompany}
						/>
						<LibraryField
							label={t`Target role`}
							value={targetRole}
							maxLength={200}
							onChange={setTargetRole}
						/>
					</div>
					<div className="grid gap-1.5">
						<Label htmlFor={`${id}-research`}>
							<Trans>Company research document</Trans>
						</Label>
						<NativeSelect
							id={`${id}-research`}
							value={companyId}
							disabled={companies.isPending || companies.isError}
							onChange={(event) => setCompanyId(event.target.value)}
						>
							<option value="">
								{t`No company research linked`}
							</option>
							{companyId && !companies.data?.some((entry) => entry.id === companyId) && <option value={companyId}>
								{company || t`Linked company research`}
							</option>}
							{(companies.data ?? []).map((entry) => <option key={entry.id} value={entry.id}>
								{entry.company}
							</option>)}
						</NativeSelect>
						{companies.isError && <p className="text-xs text-ink-3">
							<Trans>Company research could not be loaded. The existing link will be kept.</Trans>
						</p>}
					</div>
					<div className="grid gap-1.5">
						<Label htmlFor={`${id}-source`}>
							<Trans>Based on resume</Trans>
						</Label>
						<NativeSelect
							id={`${id}-source`}
							value={sourceResumeId}
							onChange={(event) => setSourceResumeId(event.target.value)}
						>
							<option value="">
								{t`No source resume`}
							</option>
							{sourceResumeId && !documents.some((entry) => entry.id === sourceResumeId) && <option value={sourceResumeId}>
								{t`Source resume unavailable`}
							</option>}
							{documents.filter((entry) => entry.type === "resume" && entry.id !== document.id).map((entry) => <option key={entry.id} value={entry.id}>
								{entry.name}
							</option>)}
						</NativeSelect>
					</div>
					<LibraryField
						label={t`Skills and keywords`}
						value={keywords}
						maxLength={6000}
						placeholder={t`Robotics, Python, motion planning`}
						onChange={setKeywords}
						hint={t`Separate keywords with commas. Your agent can use these to find similar resumes.`}
					/>
					<LibraryField
						label={t`Job posting URL`}
						type="url"
						value={jobUrl}
						maxLength={2000}
						placeholder="https://"
						onChange={setJobUrl}
					/>
					<LibraryField
						label={t`Job description`}
						multiline
						value={jobDescription}
						maxLength={30000}
						className="max-h-56 min-h-28"
						onChange={setJobDescription}
					/>
					<LibraryField
						label={t`Reuse notes`}
						multiline
						value={reuseNotes}
						maxLength={5000}
						placeholder={t`What changed, why it fits this role, and when to reuse this version.`}
						onChange={setReuseNotes}
					/>
					<fieldset className="grid gap-3 rounded-lg border border-line p-4">
						<legend className="px-1 text-sm font-semibold">
							<Trans>Resume fit assessment</Trans>
						</legend>
						<p className="text-xs text-ink-3">
							<Trans>A review aid from you or your agent. This score is not a prediction of hiring outcomes.</Trans>
						</p>
						{document.profile?.score !== null && document.profile && (!document.profile.evaluatedResumeUpdatedAt || Date.parse(document.profile.evaluatedResumeUpdatedAt) < document.updatedAt.getTime()) && <p className="text-xs text-ink-2">
							<Trans>This resume changed after its last assessment. Ask your agent to review the score again.</Trans>
						</p>}
						<div className="grid gap-1.5">
							<Label htmlFor={`${id}-score`}>
								<Trans>Score out of 100</Trans>
							</Label>
							<Input
								id={`${id}-score`}
								type="number"
								min={0}
								max={100}
								step={1}
								value={score}
								className="max-w-32"
								onChange={(event) => setScore(event.target.value)}
							/>
						</div>
						<LibraryField
							label={t`Score rationale and gaps`}
							multiline
							value={scoreNotes}
							maxLength={5000}
							onChange={setScoreNotes}
						/>
						{(document.profile?.rubric.length ?? 0) > 0 && <ul className="grid gap-1 text-xs text-ink-2">
							{document.profile?.rubric.map((criterion, index) => <li key={`${index}-${criterion.criterion}`}>
								<span className="font-medium">{criterion.criterion}: {criterion.score}/{criterion.maxScore}</span>
								{criterion.notes && <p>
									{criterion.notes}
								</p>}
							</li>)}
						</ul>}
					</fieldset>
					<fieldset className="grid gap-3 rounded-lg border border-line p-4">
						<legend className="px-1 text-sm font-semibold"><Trans>Application outcome</Trans></legend>
						<p className="text-xs leading-5 text-ink-3"><Trans>Track which resume version you submitted and what happened next.</Trans></p>
						<div className="grid gap-1.5">
							<Label htmlFor={`${id}-outcome`}><Trans>Stage</Trans></Label>
							<NativeSelect id={`${id}-outcome`} value={outcomeStage} onChange={(event) => setOutcomeStage(event.target.value as OutcomeStage)}>
								{OUTCOME_STAGES.map((stage) => <option key={stage} value={stage}>{outcomeStageLabel(stage)}</option>)}
							</NativeSelect>
						</div>
						<LibraryField label={t`Outcome notes`} value={outcomeNotes} onChange={setOutcomeNotes} maxLength={5000} multiline />
						{document.profile?.outcome?.recordedAt && <p className="text-xs text-ink-3">
							<Trans>Recorded: {new Date(document.profile.outcome.recordedAt).toLocaleString(i18n.locale)}</Trans>
						</p>}
					</fieldset>
				</TabsContent>
				<TabsContent value="review">
					<ResumeReviewPanel document={liveDocument} documents={documents} />
				</TabsContent>
				<TabsContent value="related">
					<RelatedResumesPanel document={liveDocument} />
				</TabsContent>
			</Tabs>
			{error && <p role="alert" className="text-sm text-danger-text">
				{error}
			</p>}
			<DialogFooter>
				<Button type="button" variant="ghost" onClick={onClose}>
					<Trans>Cancel</Trans>
				</Button>
				{section === "details" && <Button
					type="submit"
					loading={saveMetadata.isPending}
					disabled={folders.isPending || folders.isError}
				>
					<Trans>Save details</Trans>
				</Button>}
			</DialogFooter>
		</form>
	</DialogContent>;
}
