import type { QueueItem } from "@reactive-resume/api/dto/capture";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "@reactive-resume/ui/components/button";
import { Input } from "@reactive-resume/ui/components/input";
import { Label } from "@reactive-resume/ui/components/label";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@reactive-resume/ui/components/sheet";
import { Skeleton } from "@reactive-resume/ui/components/skeleton";
import { Textarea } from "@reactive-resume/ui/components/textarea";
import { toast } from "@reactive-resume/ui/components/toast";
import { getOrpcErrorMessage } from "@/libs/error-message";
import { orpc } from "@/libs/orpc/client";

type QueueDetailsSheetProps = { id: string; onClose: () => void };

/** A focused, deterministic editor: pasting a description never invokes an AI provider. */
export function QueueDetailsSheet({ id, onClose }: QueueDetailsSheetProps) {
	const [saving, setSaving] = useState(false);
	const query = useQuery(orpc.applications.queue.read.queryOptions({ input: { id, includeDescription: true } }));
	return (
		<Sheet open onOpenChange={(open) => !open && !saving && onClose()}>
			<SheetContent side="right" className="w-full data-[side=right]:sm:max-w-xl">
				<SheetHeader>
					<SheetTitle>
						<Trans>Review saved job details</Trans>
					</SheetTitle>
					<SheetDescription>
						<Trans>Confirm the company, role and description before Claude works on this job.</Trans>
					</SheetDescription>
				</SheetHeader>
				{query.isPending ? (
					<Skeleton className="mx-4 h-80" />
				) : query.isError ? (
					<div role="alert" className="grid gap-3 px-4 text-sm">
						<p>
							<Trans>Couldn't load this saved job. Try again.</Trans>
						</p>
						<Button variant="secondary" disabled={query.isFetching} onClick={() => void query.refetch()}>
							<Trans>Retry</Trans>
						</Button>
					</div>
				) : (
					<QueueDetailsForm
						key={query.data.id}
						item={query.data}
						onClose={onClose}
						onSaving={setSaving}
					/>
				)}
			</SheetContent>
		</Sheet>
	);
}

type QueueDetailsFormProps = { item: QueueItem; onClose: () => void; onSaving: (saving: boolean) => void };

function QueueDetailsForm({ item, onClose, onSaving }: QueueDetailsFormProps) {
	const id = useId();
	const queryClient = useQueryClient();
	// Keep the revision the user actually reviewed. A background refresh must not silently
	// authorize overwriting newer agent notes or discard the user's unsaved edits.
	const [expectedRevision] = useState(item.preparation.revision);
	const [company, setCompany] = useState(item.company);
	const [role, setRole] = useState(item.role);
	const [description, setDescription] = useState(item.description ?? "");
	const [notes, setNotes] = useState(item.preparation.notes);
	const [error, setError] = useState<string | null>(null);
	const update = useMutation(orpc.applications.queue.update.mutationOptions());
	const working = item.preparation.state === "processing";

	const save = async () => {
		if (!company.trim() || !role.trim() || update.isPending || working) return;
		setError(null);
		onSaving(true);
		try {
			await update.mutateAsync({
				id: item.id,
				expectedRevision,
				company: company.trim(),
				role: role.trim(),
				description,
				notes,
			});
			await queryClient.invalidateQueries({ queryKey: orpc.applications.key() });
			toast.add({
				type: "success",
				description: t`Saved job details. Missing information is checked again automatically.`,
			});
			onClose();
		} catch (cause) {
			setError(
				getOrpcErrorMessage(cause, { fallback: t`Couldn't save these details. Your edits are still here.` }),
			);
		} finally {
			onSaving(false);
		}
	};

	return (
		<form
			className="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto px-4 pb-4"
			onSubmit={(event) => {
				event.preventDefault();
				void save();
			}}
		>
			{working && (
				<p role="status" className="rounded-lg bg-warn-soft p-3 text-sm text-warn-text">
					<Trans>Claude is working on this job. Edit its details after processing finishes.</Trans>
				</p>
			)}
			<div className="grid gap-1.5">
				<Label htmlFor={`${id}-company`}>
					<Trans>Company</Trans>
				</Label>
				<Input
					id={`${id}-company`}
					value={company}
					maxLength={300}
					required
					disabled={working || update.isPending}
					onChange={(event) => setCompany(event.target.value)}
				/>
			</div>
			<div className="grid gap-1.5">
				<Label htmlFor={`${id}-role`}>
					<Trans>Role / title</Trans>
				</Label>
				<Input
					id={`${id}-role`}
					value={role}
					maxLength={300}
					required
					disabled={working || update.isPending}
					onChange={(event) => setRole(event.target.value)}
				/>
			</div>
			<div className="grid gap-1.5">
				<Label htmlFor={`${id}-description`}>
					<Trans>Saved job description</Trans>
				</Label>
				<Textarea
					id={`${id}-description`}
					className="field-sizing-fixed min-h-64"
					value={description}
					maxLength={20_000}
					disabled={working || update.isPending}
					onChange={(event) => setDescription(event.target.value)}
				/>
				<p className="text-xs text-ink-3">
					<Trans>Paste the full posting if capture missed it. Saving here does not use AI.</Trans>
				</p>
				{item.truncated && (
					<p className="text-xs text-warn-text">
						<Trans>The captured description was shortened. Check that the important requirements are included.</Trans>
					</p>
				)}
			</div>
			<div className="grid gap-1.5">
				<Label htmlFor={`${id}-notes`}>
					<Trans>Preparation notes</Trans>
				</Label>
				<Textarea
					id={`${id}-notes`}
					value={notes}
					maxLength={5000}
					rows={3}
					disabled={working || update.isPending}
					onChange={(event) => setNotes(event.target.value)}
				/>
			</div>
			{error && (
				<p role="alert" className="text-sm text-danger-text">
					{error}
				</p>
			)}
			<div className="flex flex-wrap justify-end gap-2">
				<Button type="button" variant="secondary" disabled={update.isPending} onClick={onClose}>
					<Trans>Cancel</Trans>
				</Button>
				<Button type="submit" disabled={!company.trim() || !role.trim() || working || update.isPending}>
					<Trans>Save details</Trans>
				</Button>
			</div>
		</form>
	);
}
