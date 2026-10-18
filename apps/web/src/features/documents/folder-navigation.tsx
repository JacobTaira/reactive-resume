import type { FolderEntry } from "./folders";
import { t } from "@lingui/core/macro";
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
import { Input } from "@reactive-resume/ui/components/input";
import { Label } from "@reactive-resume/ui/components/label";
import { NativeSelect } from "@reactive-resume/ui/components/native-select";
import { Skeleton } from "@reactive-resume/ui/components/skeleton";
import { toast } from "@reactive-resume/ui/components/toast";
import { folderPaths } from "./folders";
import { useConfirm } from "@/hooks/use-confirm";
import { getOrpcErrorMessage } from "@/libs/error-message";
import { orpc } from "@/libs/orpc/client";

type FolderNavigationProps = {
	folderId: string | undefined;
	onChange: (folderId: string | undefined) => void;
	onNewResume: () => void;
};

export function FolderNavigation({ folderId, onChange, onNewResume }: FolderNavigationProps) {
	const queryClient = useQueryClient();
	const confirm = useConfirm();
	const [editing, setEditing] = useState<FolderEntry | "new" | null>(null);
	const folders = useQuery(orpc.library.folders.list.queryOptions({ input: {} }));
	const selected = folders.data?.find((folder) => folder.id === folderId);
	const refresh = () => Promise.all([
		queryClient.invalidateQueries({ queryKey: orpc.library.key() }),
		queryClient.invalidateQueries({ queryKey: orpc.documents.key() }),
	]);
	const remove = useMutation(orpc.library.folders.delete.mutationOptions({ onSuccess: refresh }));
	const failed = (error: unknown) => toast.add({ type: "error", description: getOrpcErrorMessage(error, { fallback: t`Couldn't update folders. Try again.` }) });
	const deleteFolder = async () => {
		if (!selected) return;
		if (!await confirm(t`Delete folder “${selected.name}”?`, { description: t`Resumes and subfolders move to the parent folder. No resumes are deleted.`, confirmText: t`Delete folder` })) return;
		try {
			await remove.mutateAsync({ id: selected.id });
			onChange(undefined);
		} catch (error) {
			failed(error);
		}
	};

	return (
		<section className="grid gap-2" aria-label={t`Resume folders`}>
			<div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-raised p-3">
				<Icon name="folder" className="text-ink-2" />
				{folders.isPending ? <Skeleton className="h-9 w-64" /> : folders.isError ? (
					<div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-danger-text">
					<Trans>Couldn't load folders.</Trans>
					<Button
						variant="ghost"
						size="sm"
						loading={folders.isFetching}
						onClick={() => void folders.refetch()}
					>
						<Trans>Try again</Trans>
					</Button>
				</div>
				) : (
					<div className="min-w-0 flex-1 sm:max-w-sm">
					<NativeSelect
						aria-label={t`Folder`}
						value={folderId ?? "__all"}
						onChange={(event) => onChange(event.target.value === "__all" ? undefined : event.target.value)}
					>
						<option value="__all">
							{t`All documents`}
						</option>
						<option value="">
							{t`Unfiled resumes`}
						</option>
						{folderPaths(folders.data ?? []).map((folder) => <option key={folder.id} value={folder.id}>
							{folder.path}
						</option>)}
					</NativeSelect>
				</div>
				)}
				<Button variant="secondary" size="sm" onClick={onNewResume}>
					<Icon name="file-plus" />
					<Trans>New resume</Trans>
				</Button>
				<Button
					variant="secondary"
					size="sm"
					disabled={folders.isPending || folders.isError}
					onClick={() => setEditing("new")}
				>
					<Icon name="plus" />
					<Trans>New folder</Trans>
				</Button>
				{selected && <>
					<Button variant="ghost" size="sm" onClick={() => setEditing(selected)}>
						<Trans>Rename</Trans>
					</Button>
					<Button variant="ghost" size="sm" disabled={remove.isPending} onClick={() => void deleteFolder()}>
						<Trans>Delete folder</Trans>
					</Button>
				</>}
			</div>
			{folderId !== undefined && <p className="text-xs text-ink-3">
				<Trans>Folders organize resumes. Company research lives in Companies.</Trans>
			</p>}
			<Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
				{editing && <FolderEditor
					key={typeof editing === "string" ? editing : editing.id}
					folder={editing === "new" ? null : editing}
					parentId={selected?.id ?? null}
					onSaved={(id) => { setEditing(null); onChange(id); }}
				/>}
			</Dialog>
		</section>
	);
}

type FolderEditorProps = { folder: FolderEntry | null; parentId: string | null; onSaved: (id: string) => void };

function FolderEditor({ folder, parentId, onSaved }: FolderEditorProps) {
	const id = useId();
	const queryClient = useQueryClient();
	const [name, setName] = useState(folder?.name ?? "");
	const [error, setError] = useState<string | null>(null);
	const create = useMutation(orpc.library.folders.create.mutationOptions());
	const update = useMutation(orpc.library.folders.update.mutationOptions());
	const save = async () => {
		setError(null);
		try {
			const saved = folder ? await update.mutateAsync({ id: folder.id, name: name.trim() }) : await create.mutateAsync({ name: name.trim(), parentId });
			await queryClient.invalidateQueries({ queryKey: orpc.library.key() });
			onSaved(saved.id);
		} catch (cause) { setError(getOrpcErrorMessage(cause, { fallback: t`Couldn't save the folder. Try again.` })); }
	};
	return <DialogContent>
		<form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
			<DialogHeader>
				<DialogTitle>
					{folder ? <Trans>Rename folder</Trans> : <Trans>New folder</Trans>}
				</DialogTitle>
				<DialogDescription>
					{folder ? <Trans>Choose a name that helps you and your agent find related resumes.</Trans> : <Trans>The folder is created inside the current folder, or at the top level when viewing all documents.</Trans>}
				</DialogDescription>
			</DialogHeader>
			<Label htmlFor={id}>
				<Trans>Folder name</Trans>
			</Label>
			<Input id={id} value={name} maxLength={100} required onChange={(event) => setName(event.target.value)} />
			{error && <p role="alert" className="text-sm text-danger-text">
				{error}
			</p>}
			<DialogFooter>
				<Button type="submit" disabled={!name.trim()} loading={create.isPending || update.isPending}>
					<Trans>Save</Trans>
				</Button>
			</DialogFooter>
		</form>
	</DialogContent>;
}
