import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { Link, useMatchRoute, useSearch } from "@tanstack/react-router";
import { Icon } from "@reactive-resume/ui/components/icon";
import { Skeleton } from "@reactive-resume/ui/components/skeleton";
import { cn } from "@reactive-resume/utils/style";
import { folderPaths } from "./folders";
import { useResumeFolderDrop } from "./resume-folder-drag";
import { orpc } from "@/libs/orpc/client";

type FolderMenuProps = { variant?: "sidebar" | "inline" };

/** Always-visible folder destinations share the folder picker's cache, including newly created folders. */
export function FolderMenu({ variant = "sidebar" }: FolderMenuProps) {
	const folders = useQuery(orpc.library.folders.list.queryOptions({ input: {} }));
	const { folderId, area } = useSearch({ strict: false });
	const matchRoute = useMatchRoute();
	const inDocuments = Boolean(matchRoute({ to: "/dashboard", fuzzy: false })) && area !== "companies";
	return (
		<nav
			aria-label={t`Resume folders`}
			className={variant === "sidebar"
				? "ms-3 grid gap-0.5 border-s border-line ps-2"
				: "grid max-h-60 gap-1 overflow-y-auto sm:grid-cols-2"}
		>
			<FolderLink folderId={null} name={t`Unfiled resumes`} current={inDocuments && folderId === ""} />
			{folders.isPending && <Skeleton className="h-8 w-full" />}
			{folders.isError && (
				<button
					type="button"
					onClick={() => void folders.refetch()}
					className="rounded-lg px-2 py-1.5 text-start text-xs text-danger-text hover:bg-hover"
				>
					<Trans>Couldn't load folders. Try again.</Trans>
				</button>
			)}
			{folderPaths(folders.data ?? []).map((folder) => (
				<FolderLink key={folder.id} folderId={folder.id} name={folder.path} current={inDocuments && folderId === folder.id} />
			))}
		</nav>
	);
}

type FolderLinkProps = { folderId: string | null; name: string; current: boolean };

function FolderLink({ folderId, name, current }: FolderLinkProps) {
	const { isOver, dropProps } = useResumeFolderDrop(folderId);
	return (
		<Link
			to="/dashboard"
			search={{ folderId: folderId ?? "", type: "all" }}
			draggable={false}
			aria-current={current ? "page" : undefined}
			title={name}
			{...dropProps}
			className={cn(
				"flex min-h-8 min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors",
				current ? "bg-sunken font-medium text-ink" : "text-ink-2 hover:bg-hover hover:text-ink",
				isOver && "bg-accent-soft text-accent-text outline-2 outline-accent outline-offset-[-2px]",
			)}
		>
			<Icon name="folder" size={16} filled={current || isOver} className="shrink-0" />
			<span className="truncate">{name}</span>
		</Link>
	);
}
