import type { QueueItem } from "@reactive-resume/api/dto/capture";
import type { QueueFilter, QueueState } from "./queue-model";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@reactive-resume/ui/components/button";
import { Icon } from "@reactive-resume/ui/components/icon";
import { Skeleton } from "@reactive-resume/ui/components/skeleton";
import { toast } from "@reactive-resume/ui/components/toast";
import { cn } from "@reactive-resume/utils/style";
import { QueueDetailsSheet } from "./queue-details-sheet";
import { queueCanRequeue, queueFilterStates } from "./queue-model";
import { getOrpcErrorMessage } from "@/libs/error-message";
import { orpc } from "@/libs/orpc/client";

type QueueViewProps = { query: string; onOpen: (id: string) => void; onAdd: () => void };

const PAGE_SIZE = 30;

export function QueueView({ query, onOpen, onAdd }: QueueViewProps) {
	const queryClient = useQueryClient();
	const [filter, setFilter] = useState<QueueFilter>("active");
	const [offset, setOffset] = useState(0);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [searchValue, setSearchValue] = useState(query);
	if (query !== searchValue) {
		setSearchValue(query);
		setOffset(0);
	}
	const list = useQuery({
		...orpc.applications.queue.list.queryOptions({
			input: {
				states: queueFilterStates(filter),
				limit: PAGE_SIZE,
				offset,
				includeDescription: false,
				...(query.trim() ? { query: query.trim() } : {}),
			},
		}),
		refetchInterval: 30_000,
	});
	const action = useMutation(orpc.applications.queue.action.mutationOptions());
	const counts = list.data?.counts;
	const filters: { value: QueueFilter; label: string; count?: number | undefined }[] = [
		{ value: "active", label: t`Needs work` },
		{ value: "pending", label: t`Queued`, count: counts?.pending },
		{ value: "needs_details", label: t`Missing details`, count: counts?.needs_details },
		{ value: "processing", label: t`In progress`, count: counts?.processing },
		{ value: "failed", label: t`Needs attention`, count: counts?.failed },
		{ value: "ready", label: t`Ready for review`, count: counts?.ready },
		{ value: "skipped", label: t`Skipped`, count: counts?.skipped },
	];

	const change = async (item: QueueItem, next: "skip" | "requeue") => {
		try {
			await action.mutateAsync({ id: item.id, expectedRevision: item.preparation.revision, action: next });
			await queryClient.invalidateQueries({ queryKey: orpc.applications.key() });
			toast.add({
				type: "success",
				description:
					next === "skip"
						? t`Skipped. This job stays in Applications.`
						: t`Job returned to the queue. Ask Claude when you want to resume.`,
			});
		} catch (error) {
			toast.add({
				type: "error",
				description: getOrpcErrorMessage(error, {
					fallback: t`Couldn't update the queue. Refresh and try again.`,
				}),
			});
			void queryClient.invalidateQueries({ queryKey: orpc.applications.queue.key() });
		}
	};

	const copyPrompt = async () => {
		try {
			await navigator.clipboard.writeText(
				t`Process my Reactive Resume tailoring queue following my Claude project instructions. Start each new job from Base Resume and explicitly name its copy with the company and role; related resumes are references. Batch-read saved job descriptions with list_tailoring_queue(includeDescription=true), and read selected resumes with read_resume(includeMetadata=true). Reuse verified master evidence and company notes across similar jobs; refresh changed sources rather than repeatedly reading unchanged documents. Before drafting, compare the jobs for shared requirements and gaps. Ask me once about shared unknown facts only when they materially affect the application; record confirmed experience gaps without asking again whether to draft. Add only facts I confirm for inclusion to Base Resume. Use the queue tools to keep progress and failures visible. Reuse an existing draft when resuming. Save the complete requirement evidence, change rationale and score rubric together after final review. Mark a resume ready only after tailoring, scoring, freshness checks and PDF checks. Keep scores, evidence, changes and links in the app. Reply only with brief unsupported requirements, material facts needing confirmation or formatting/PDF/workflow problems; do not narrate progress or repeat the resume. Do not submit applications or mark them Applied.`,
			);
			toast.add({
				type: "success",
				description: t`Prompt copied. Paste it into Claude connected to this installation.`,
			});
		} catch {
			toast.add({
				type: "error",
				description: t`Couldn't copy the prompt. Tell Claude: Process my queue using my master resume.`,
			});
		}
	};

	return (
		<section aria-label={t`Resume preparation queue`} className="grid gap-4">
			<div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-line bg-sunken/40 p-4">
				<div className="grid max-w-2xl gap-1.5">
					<h2 className="font-semibold">
						<Trans>Saved jobs, ready when you are</Trans>
					</h2>
					<p className="text-sm text-ink-2">
						<Trans>
							Save jobs with the Chrome extension or the Save job button. Then ask Claude to process your queue.
							Capturing a job does not start resume writing.
						</Trans>
					</p>
					<p className="text-xs text-ink-3">
						<Trans>
							Jobs stay here through missing details, interrupted work and draft creation. Only completed resumes move
							to Ready for review.
						</Trans>
					</p>
				</div>
				<Button variant="secondary" onClick={() => void copyPrompt()}>
					<Icon name="copy" size={18} />
					<Trans>Copy Claude prompt</Trans>
				</Button>
			</div>

			<div aria-label={t`Queue status`} className="flex flex-wrap gap-1.5">
				{filters.map((option) => (
					<Button
						key={option.value}
						size="sm"
						variant="secondary"
						aria-pressed={filter === option.value}
						className={cn(filter === option.value && "bg-accent-soft text-accent-text")}
						onClick={() => {
							setFilter(option.value);
							setOffset(0);
						}}
					>
						{option.label}
						{option.count !== undefined && <span className="tabular-nums text-ink-3">{option.count}</span>}
					</Button>
				))}
			</div>

			{list.isError && (
				<div
					role="alert"
					className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line p-4"
				>
					<p className="text-sm text-danger-text">
						<Trans>Couldn't load the queue. Your saved jobs remain in Applications.</Trans>
					</p>
					<Button variant="secondary" disabled={list.isFetching} onClick={() => void list.refetch()}>
						<Trans>Retry</Trans>
					</Button>
				</div>
			)}
			{list.isPending ? (
				<div className="grid gap-3">
					{[0, 1, 2].map((value) => <Skeleton key={value} className="h-40 rounded-xl" />)}
				</div>
			) : list.data && list.data.items.length === 0 ? (
				<div className="grid justify-items-center gap-3 rounded-xl border border-dashed border-line px-4 py-12 text-center">
					<Icon name="list-checks" size={28} className="text-ink-3" />
					<h3 className="font-medium">
						{query.trim() ? (
							<Trans>No queued jobs match this search.</Trans>
						) : filter === "ready" ? (
							<Trans>No resumes ready for review yet.</Trans>
						) : filter === "skipped" ? (
							<Trans>No skipped jobs.</Trans>
						) : (
							<Trans>No jobs in this queue view.</Trans>
						)}
					</h3>
					<p className="max-w-lg text-sm text-ink-2">
						<Trans>
							Saving a job keeps its description here even if the original posting disappears. Claude works on it
							after you ask.
						</Trans>
					</p>
					<Button variant="secondary" onClick={onAdd}>
						<Icon name="plus" size={18} />
						<Trans>Save job</Trans>
					</Button>
				</div>
			) : (
				<div className="grid gap-3">
					{list.data?.items.map((item) => (
						<QueueCard
							key={item.id}
							item={item}
							busy={action.isPending}
							onOpen={() => onOpen(item.id)}
							onEdit={() => setEditingId(item.id)}
							onAction={(next) => void change(item, next)}
						/>
					))}
				</div>
			)}

			{list.data && (offset > 0 || list.data.nextOffset !== null) && (
				<div className="flex items-center justify-between gap-3">
					<Button
						variant="secondary"
						disabled={offset === 0 || list.isFetching}
						onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
					>
						<Trans>Previous</Trans>
					</Button>
					<span className="text-sm text-ink-3"><Trans>{list.data.total} jobs in this view</Trans></span>
					<Button
						variant="secondary"
						disabled={list.data.nextOffset === null || list.isFetching}
						onClick={() => {
							if (list.data?.nextOffset !== null && list.data?.nextOffset !== undefined) setOffset(list.data.nextOffset);
						}}
					>
						<Trans>Next</Trans>
					</Button>
				</div>
			)}
			{editingId && <QueueDetailsSheet id={editingId} onClose={() => setEditingId(null)} />}
		</section>
	);
}

type QueueCardProps = {
	item: QueueItem;
	busy: boolean;
	onOpen: () => void;
	onEdit: () => void;
	onAction: (action: "skip" | "requeue") => void;
};

function QueueCard({ item, busy, onOpen, onEdit, onAction }: QueueCardProps) {
	const { preparation } = item;
	const captured = item.capturedAt ?? item.createdAt;
	const date = new Date(captured);
	const working = preparation.state === "processing";
	return (
		<article className="grid gap-3 rounded-xl border border-line p-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="grid min-w-0 gap-1">
					<button type="button" className="text-start font-semibold hover:underline" onClick={onOpen}>
						{item.role}
					</button>
					<p className="text-sm text-ink-2">{[item.company, item.location].filter(Boolean).join(" · ")}</p>
				</div>
				<QueueStateBadge state={preparation.state} />
			</div>
			<div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-3">
				<time dateTime={captured}>{Number.isNaN(date.getTime()) ? captured : date.toLocaleString()}</time>
				<span><Trans>{item.descriptionLength} description characters</Trans></span>
				{item.truncated && (
					<span className="text-warn-text"><Trans>Description shortened</Trans></span>
				)}
				{item.sourceUrl && (
					<a
						href={item.sourceUrl}
						target="_blank"
						rel="noopener noreferrer"
						className="inline-flex items-center gap-1 hover:underline"
					>
						<Trans>Original posting</Trans>
						<Icon name="arrow-square-out" size={12} />
					</a>
				)}
			</div>
			{preparation.state === "needs_details" && (
				<p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn-text">
					<Trans>Confirm the company and role, and add a description if it is missing.</Trans>
				</p>
			)}
			{preparation.error && (
				<p role="status" className="rounded-lg bg-warn-soft px-3 py-2 text-sm whitespace-pre-wrap text-warn-text">
					{preparation.error}
				</p>
			)}
			{preparation.notes && (
				<p className="line-clamp-4 text-sm whitespace-pre-wrap text-ink-2">{preparation.notes}</p>
			)}
			{working && (
				<p className="text-sm text-ink-2">
					<Trans>
						Claude is working on this job. If its session stops, you can resume later without losing the saved job or
						draft.
					</Trans>
				</p>
			)}
			<div className="flex flex-wrap gap-2">
				{preparation.draftResumeId && (
					<Button
						size="sm"
						variant={preparation.state === "ready" ? "primary" : "secondary"}
						render={<Link to="/builder/$resumeId" params={{ resumeId: preparation.draftResumeId }} />}
					>
						<Icon name="file-text" size={16} />
						{preparation.state === "ready" ? <Trans>Review resume</Trans> : <Trans>Open draft</Trans>}
					</Button>
				)}
				<Button size="sm" variant="secondary" disabled={busy || working} onClick={onEdit}>
					<Trans>Review details</Trans>
				</Button>
				<Button size="sm" variant="ghost" onClick={onOpen}>
					<Trans>Open application</Trans>
				</Button>
				{queueCanRequeue(item) && (
					<Button size="sm" variant="secondary" disabled={busy} onClick={() => onAction("requeue")}>
						<Icon name="arrow-clockwise" size={16} />
						<Trans>Queue again</Trans>
					</Button>
				)}
				{preparation.state !== "skipped" && !working && (
					<Button size="sm" variant="ghost" disabled={busy} onClick={() => onAction("skip")}>
						<Trans>Skip</Trans>
					</Button>
				)}
			</div>
		</article>
	);
}

type QueueStateBadgeProps = { state: QueueState };

function QueueStateBadge({ state }: QueueStateBadgeProps) {
	const labels: Record<QueueState, string> = {
		pending: t`Queued`,
		needs_details: t`Missing details`,
		processing: t`In progress`,
		ready: t`Ready for review`,
		failed: t`Needs attention`,
		skipped: t`Skipped`,
	};
	return (
		<span
			className={cn(
				"rounded-md px-2 py-1 text-xs font-medium",
				state === "ready"
					? "bg-accent-soft text-accent-text"
					: state === "needs_details" || state === "failed"
						? "bg-warn-soft text-warn-text"
						: "bg-sunken text-ink-2",
			)}
		>
			{labels[state]}
		</span>
	);
}
