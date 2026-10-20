import type { RouterOutput } from "@/libs/orpc/client";
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
import { Icon } from "@reactive-resume/ui/components/icon";
import { IconButton } from "@reactive-resume/ui/components/icon-button";
import { Input } from "@reactive-resume/ui/components/input";
import { Label } from "@reactive-resume/ui/components/label";
import { Skeleton } from "@reactive-resume/ui/components/skeleton";
import { toast } from "@reactive-resume/ui/components/toast";
import { LibraryField } from "./library-field";
import { useConfirm } from "@/hooks/use-confirm";
import { getOrpcErrorMessage } from "@/libs/error-message";
import { formatRelativeTime } from "@/libs/locale";
import { orpc } from "@/libs/orpc/client";

type CompanyResearch = RouterOutput["library"]["companies"]["getById"];

export function CompaniesLibrary() {
	const { i18n } = useLingui();
	const [query, setQuery] = useState("");
	const [editing, setEditing] = useState<string | null>(null);
	const companies = useQuery(orpc.library.companies.list.queryOptions({ input: { query: query.trim(), limit: 100 } }));
	const shown = companies.data ?? [];

	return <section className="grid gap-5">
		<div className="flex flex-wrap items-start gap-4">
			<p className="max-w-2xl flex-1 text-sm leading-6 text-ink-2">
				<Trans>Keep one research document per company. You and Claude can build on the same values, culture, hiring priorities, and dated sources when tailoring future resumes.</Trans>
			</p>
			<Button onClick={() => setEditing("new")}>
				<Icon name="plus" />
				<Trans>New company</Trans>
			</Button>
		</div>
		<Input
			type="search"
			value={query}
			aria-label={t`Search companies`}
			placeholder={t`Search companies, values, and hiring priorities`}
			className="max-w-md"
			maxLength={300}
			onChange={(event) => setQuery(event.target.value)}
		/>
		{companies.isError && <div role="alert" className="grid justify-items-start gap-2 rounded-lg border border-line p-4">
			<p className="text-sm text-danger-text">
				<Trans>Couldn't load company research.</Trans>
			</p>
			<Button variant="secondary" loading={companies.isFetching} onClick={() => void companies.refetch()}>
				<Trans>Try again</Trans>
			</Button>
		</div>}
		{companies.isPending ? <div className="grid gap-3 sm:grid-cols-2">
			{[0, 1, 2, 3].map((index) => <Skeleton key={index} className="h-36 rounded-xl" />)}
		</div> : companies.isError && !companies.data ? null : shown.length === 0 ? (
			<div className="grid justify-items-center gap-3 rounded-xl border border-dashed border-line-2 px-6 py-14 text-center">
			<Icon name="building-office" size={28} className="text-ink-3" />
			<h2 className="font-semibold">
				{query.trim() ? <Trans>No matching companies</Trans> : <Trans>Your company research starts here</Trans>}
			</h2>
			<p className="max-w-md text-sm text-ink-2">
				{query.trim() ? <Trans>Try another company name or keyword.</Trans> : <Trans>Add a company yourself, or ask Claude to save its research here through MCP.</Trans>}
			</p>
			{!query.trim() && <Button variant="secondary" onClick={() => setEditing("new")}>
				<Trans>Add a company</Trans>
			</Button>}
		</div>
		) : <div className="grid gap-3 sm:grid-cols-2">
			{shown.map((company) => <button
				type="button"
				key={company.id}
				onClick={() => setEditing(company.id)}
				className="grid content-start gap-3 rounded-xl border border-line bg-raised p-5 text-start transition-colors hover:border-line-2 hover:bg-hover"
			>
				<div className="flex items-center gap-2">
					<Icon name="building-office" className="text-ink-2" />
					<h2 className="truncate font-semibold">
						{company.company}
					</h2>
				</div>
				<p className="line-clamp-3 text-sm leading-5 text-ink-2">
					{company.summary || t`No summary yet. Open to add research.`}
				</p>
				{company.coreValues.length > 0 && <p className="line-clamp-2 text-xs text-ink-3">
					{company.coreValues.join(" · ")}
				</p>}
				<p className="text-xs text-ink-3">
					<Trans>{company.sourceCount} sources · Updated {formatRelativeTime(company.updatedAt, i18n.locale)}</Trans>
				</p>
			</button>)}
		</div>}
		<Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
			{editing === "new" ? <CompanyResearchForm key="new" document={null} onClose={() => setEditing(null)} /> : editing && <ExistingCompanyResearch key={editing} companyId={editing} onClose={() => setEditing(null)} />}
		</Dialog>
	</section>;
}

type ExistingCompanyResearchProps = { companyId: string; onClose: () => void };

function ExistingCompanyResearch({ companyId, onClose }: ExistingCompanyResearchProps) {
	const company = useQuery(orpc.library.companies.getById.queryOptions({ input: { id: companyId } }));
	if (company.data) return <CompanyResearchForm document={company.data} onClose={onClose} />;
	return <DialogContent>
		<DialogHeader>
			<DialogTitle>
				<Trans>Company research</Trans>
			</DialogTitle>
			<DialogDescription>
				<Trans>Loading the company's research document.</Trans>
			</DialogDescription>
		</DialogHeader>
		{company.isError ? <div role="alert" className="grid gap-3">
			<p className="text-sm text-danger-text">
				<Trans>Couldn't load company research.</Trans>
			</p>
			<Button variant="secondary" loading={company.isFetching} onClick={() => void company.refetch()}>
				<Trans>Try again</Trans>
			</Button>
		</div> : <Skeleton className="h-60" />}
	</DialogContent>;
}

type CompanyResearchFormProps = { document: CompanyResearch | null; onClose: () => void };
type ResearchSource = CompanyResearch["sources"][number];
const parseLabels = (value: string) => [...new Set(value.split(",").map((part) => part.trim()).filter(Boolean))];

function CompanyResearchForm({ document, onClose }: CompanyResearchFormProps) {
	const id = useId();
	const queryClient = useQueryClient();
	const confirm = useConfirm();
	const [revision] = useState(document?.revision);
	const [company, setCompany] = useState(document?.company ?? "");
	const [website, setWebsite] = useState(document?.website ?? "");
	const [summary, setSummary] = useState(document?.summary ?? "");
	const [coreValues, setCoreValues] = useState(document?.coreValues.join(", ") ?? "");
	const [culture, setCulture] = useState(document?.culture ?? "");
	const [hiringPriorities, setHiringPriorities] = useState(document?.hiringPriorities.join(", ") ?? "");
	const [notes, setNotes] = useState(document?.notes ?? "");
	const [sources, setSources] = useState<ResearchSource[]>(document?.sources ?? []);
	const [error, setError] = useState<string | null>(null);
	const saveCompany = useMutation(orpc.library.companies.save.mutationOptions());
	const deleteCompany = useMutation(orpc.library.companies.delete.mutationOptions());
	const busy = saveCompany.isPending || deleteCompany.isPending;
	const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.library.key() });
	const save = async () => {
		setError(null);
		const values = document && coreValues === document.coreValues.join(", ")
			? document.coreValues : parseLabels(coreValues);
		const priorities = document && hiringPriorities === document.hiringPriorities.join(", ")
			? document.hiringPriorities : parseLabels(hiringPriorities);
		if ([values, priorities].some((labels) => labels.length > 50 || labels.some((label) => label.length > 120))) {
			setError(t`Use up to 50 values or priorities, with no more than 120 characters each.`);
			return;
		}
		try {
			await saveCompany.mutateAsync({
				...(document && revision ? { id: document.id, expectedRevision: revision } : {}),
				company: company.trim(),
				website: website.trim(),
				summary,
				coreValues: values,
				culture,
				hiringPriorities: priorities,
				notes,
				sources,
			});
			await refresh();
			toast.add({ description: t`Company research saved` });
			onClose();
		} catch (cause) { setError(getOrpcErrorMessage(cause, { fallback: t`Couldn't save company research. Try again. If it changed elsewhere, close and reopen it before editing.` })); }
	};
	const remove = async () => {
		if (!document || !revision) return;
		if (!await confirm(t`Delete research for ${document.company}?`, { description: t`The company research document will be deleted. Your resumes are kept.`, confirmText: t`Delete research` })) return;
		try {
			await deleteCompany.mutateAsync({ id: document.id, expectedRevision: revision });
			await refresh();
			onClose();
		} catch (cause) { setError(getOrpcErrorMessage(cause, { fallback: t`Couldn't delete company research. Try again.` })); }
	};
	const updateSource = (index: number, patch: Partial<ResearchSource>) => setSources((current) => current.map((source, position) => position === index ? { ...source, ...patch } : source));

	return <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
		<form className="grid gap-5" onSubmit={(event) => { event.preventDefault(); void save(); }}>
			<DialogHeader>
				<DialogTitle>
					{document ? <Trans>Company research</Trans> : <Trans>New company</Trans>}
				</DialogTitle>
				<DialogDescription>
					<Trans>Save facts and dated sources that will help tailor future resumes. Keep guesses distinct from sourced information.</Trans>
				</DialogDescription>
			</DialogHeader>
			<div className="grid gap-4 sm:grid-cols-2">
				<LibraryField
					label={t`Company name`}
					required
					value={company}
					maxLength={200}
					onChange={setCompany}
				/>
				<LibraryField
					label={t`Company website`}
					type="url"
					value={website}
					maxLength={2000}
					placeholder="https://"
					onChange={setWebsite}
				/>
			</div>
			<LibraryField
				label={t`Research summary`}
				multiline
				value={summary}
				maxLength={5000}
				onChange={setSummary}
			/>
			<LibraryField
				label={t`Core values`}
				value={coreValues}
				maxLength={6000}
				placeholder={t`Comma-separated values`}
				onChange={setCoreValues}
			/>
			<LibraryField
				label={t`Culture and working style`}
				multiline
				value={culture}
				maxLength={10000}
				onChange={setCulture}
			/>
			<LibraryField
				label={t`Hiring priorities`}
				value={hiringPriorities}
				maxLength={6000}
				placeholder={t`Comma-separated skills or qualities`}
				onChange={setHiringPriorities}
			/>
			<LibraryField
				label={t`Resume guidance and research notes`}
				multiline
				value={notes}
				maxLength={50000}
				className="max-h-80 min-h-40 font-mono text-xs"
				onChange={setNotes}
				hint={t`Plain text or Markdown. Include evidence to highlight, terminology to reuse, and open questions.`}
			/>
			<fieldset className="grid gap-3 rounded-xl border border-line p-4">
				<legend className="px-1 text-sm font-semibold">
					<Trans>Research sources</Trans>
				</legend>
				{sources.length === 0 && <p className="text-sm text-ink-3">
					<Trans>No sources yet. Add links and dates so future research can be verified.</Trans>
				</p>}
				{sources.map((source, index) => <div key={index} className="grid gap-2 rounded-lg border border-line p-3">
					<div className="flex items-center gap-2">
						<span className="flex-1 text-xs font-medium text-ink-2">
							<Trans>Source {index + 1}</Trans>
						</span>
						<IconButton
							type="button"
							icon="x"
							size="icon-sm"
							label={t`Remove source ${index + 1}`}
							onClick={() => setSources((current) => current.filter((_, position) => position !== index))}
						/>
					</div>
					<LibraryField
						label={t`Source URL`}
						type="url"
						required
						value={source.url}
						maxLength={2000}
						placeholder="https://"
						onChange={(value) => updateSource(index, { url: value })}
					/>
					<div className="grid gap-3 sm:grid-cols-2">
						<LibraryField
							label={t`Source title`}
							value={source.title}
							maxLength={300}
							onChange={(value) => updateSource(index, { title: value })}
						/>
						<div className="grid gap-1.5">
							<Label htmlFor={`${id}-source-date-${index}`}>
								<Trans>Date accessed</Trans>
							</Label>
							<Input
								id={`${id}-source-date-${index}`}
								type="date"
								required
								value={source.accessedAt.slice(0, 10)}
								onChange={(event) => { if (event.target.value) updateSource(index, { accessedAt: `${event.target.value}T12:00:00.000Z` }); }}
							/>
						</div>
					</div>
					<LibraryField
						label={t`Source notes`}
						multiline
						value={source.notes}
						maxLength={2000}
						onChange={(value) => updateSource(index, { notes: value })}
					/>
				</div>)}
				<Button
					type="button"
					variant="secondary"
					disabled={sources.length >= 100}
					onClick={() => setSources((current) => [...current, { url: "", title: "", accessedAt: new Date().toISOString(), notes: "" }])}
				>
					<Icon name="plus" />
					<Trans>Add source</Trans>
				</Button>
			</fieldset>
			{error && <p role="alert" className="text-sm text-danger-text">
				{error}
			</p>}
			<DialogFooter>
				{document && <Button
					type="button"
					variant="ghost"
					className="me-auto text-danger-text"
					disabled={busy}
					onClick={() => void remove()}
				>
					<Trans>Delete research</Trans>
				</Button>}
				<Button type="button" variant="ghost" onClick={onClose}>
					<Trans>Cancel</Trans>
				</Button>
				<Button type="submit" loading={saveCompany.isPending} disabled={busy || !company.trim()}>
					<Trans>Save research</Trans>
				</Button>
			</DialogFooter>
		</form>
	</DialogContent>;
}
