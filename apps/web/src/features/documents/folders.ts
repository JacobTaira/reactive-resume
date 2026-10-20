/** Stable paths for folder pickers, including nested folders returned in any order. */
export type FolderEntry = { id: string; name: string; parentId: string | null };

export function folderPaths(folders: readonly FolderEntry[]) {
	const byId = new Map(folders.map((folder) => [folder.id, folder]));
	const path = (folder: FolderEntry, seen: ReadonlySet<string>): string => {
		if (!folder.parentId || seen.has(folder.parentId)) return folder.name;
		const parent = byId.get(folder.parentId);
		return parent ? `${path(parent, new Set([...seen, folder.id]))} / ${folder.name}` : folder.name;
	};
	return folders
		.map((folder) => ({ ...folder, path: path(folder, new Set([folder.id])) }))
		.sort((left, right) => left.path.localeCompare(right.path, undefined, { sensitivity: "base", numeric: true }));
}
