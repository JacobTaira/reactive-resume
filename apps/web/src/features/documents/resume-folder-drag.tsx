import type { DocumentSummary } from "./filter";
import type { DragEvent, ReactNode } from "react";
import { t } from "@lingui/core/macro";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useRef, useState } from "react";
import { toast } from "@reactive-resume/ui/components/toast";
import { getOrpcErrorMessage } from "@/libs/error-message";
import { orpc } from "@/libs/orpc/client";

const RESUME_DRAG_TYPE = "application/x-reactive-resume-id";

type ResumeFolderDrag = {
	active: DocumentSummary | null;
	moving: boolean;
	start: (document: DocumentSummary, event: DragEvent<HTMLElement>) => void;
	end: () => void;
	drop: (event: DragEvent<HTMLElement>, folderId: string | null) => void;
};

const ResumeFolderDragContext = createContext<ResumeFolderDrag | null>(null);

type ResumeFolderDragProviderProps = { children: ReactNode };

/** Share only an owned document's ID with folder targets, never its resume content. */
export function ResumeFolderDragProvider({ children }: ResumeFolderDragProviderProps) {
	const queryClient = useQueryClient();
	const [active, setActive] = useState<DocumentSummary | null>(null);
	const activeRef = useRef<DocumentSummary | null>(null);
	const movingRef = useRef(false);
	const move = useMutation(orpc.library.resumes.setMetadata.mutationOptions());
	const end = () => {
		activeRef.current = null;
		setActive(null);
	};
	const drop = async (event: DragEvent<HTMLElement>, folderId: string | null) => {
		const document = activeRef.current;
		// Ignore files, URLs and drags originating outside this app, including forged custom payloads.
		if (!document || !event.dataTransfer.types.includes(RESUME_DRAG_TYPE)) return;
		event.preventDefault();
		event.stopPropagation();
		const resumeId = event.dataTransfer.getData(RESUME_DRAG_TYPE);
		end();
		if (movingRef.current || resumeId !== document.id || (document.folderId ?? null) === folderId) return;
		movingRef.current = true;
		try {
			await move.mutateAsync({ resumeId, folderId });
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: orpc.documents.key() }),
				queryClient.invalidateQueries({ queryKey: orpc.library.key() }),
				queryClient.invalidateQueries({ queryKey: orpc.resume.key() }),
			]);
			toast.add({ description: t`Resume moved` });
		} catch (error) {
			toast.add({
				type: "error",
				description: getOrpcErrorMessage(error, { fallback: t`Couldn't move the resume. Try again.` }),
			});
		} finally {
			movingRef.current = false;
		}
	};

	return (
		<ResumeFolderDragContext
			value={{
				active,
				moving: move.isPending,
				start: (document, event) => {
					if (movingRef.current || document.type !== "resume" || document.trashedAt) {
						event.preventDefault();
						return;
					}
					event.dataTransfer.clearData();
					event.dataTransfer.setData(RESUME_DRAG_TYPE, document.id);
					event.dataTransfer.effectAllowed = "move";
					activeRef.current = document;
					setActive(document);
				},
				end,
				drop: (event, folderId) => void drop(event, folderId),
			}}
		>
			{children}
		</ResumeFolderDragContext>
	);
}

export function useResumeFolderDrag(document: DocumentSummary, disabled = false) {
	const context = useContext(ResumeFolderDragContext);
	const draggable = Boolean(context && !disabled && !context.moving && document.type === "resume" && !document.trashedAt);
	return {
		draggable,
		onDragStart: (event: DragEvent<HTMLElement>) => {
			if (!draggable || (event.target instanceof Element && event.target.closest("input, button, select, textarea"))) {
				event.preventDefault();
				return;
			}
			context?.start(document, event);
		},
		onDragEnd: () => context?.end(),
	};
}

export function useResumeFolderDrop(folderId: string | null) {
	const context = useContext(ResumeFolderDragContext);
	const [over, setOver] = useState(false);
	const enabled = Boolean(context?.active && !context.moving && (context.active.folderId ?? null) !== folderId);
	return {
		isOver: enabled && over,
		dropProps: {
			onDragOver: (event: DragEvent<HTMLElement>) => {
				if (!enabled || !event.dataTransfer.types.includes(RESUME_DRAG_TYPE)) return;
				event.preventDefault();
				event.dataTransfer.dropEffect = "move";
				setOver(true);
			},
			onDragLeave: (event: DragEvent<HTMLElement>) => {
				if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setOver(false);
			},
			onDrop: (event: DragEvent<HTMLElement>) => {
				setOver(false);
				context?.drop(event, folderId);
			},
		},
	};
}
