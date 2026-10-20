import type { CSSProperties, KeyboardEvent, PointerEvent, ReactNode } from "react";
import { t } from "@lingui/core/macro";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";

const storageKey = "reactive-resume:latex-source-pane-size";
const desktopQuery = "(min-width: 64rem)";
const subscribeToLayout = (listener: () => void) => {
	const query = window.matchMedia(desktopQuery);
	query.addEventListener("change", listener);
	return () => query.removeEventListener("change", listener);
};
const isDesktop = () => window.matchMedia(desktopQuery).matches;
const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));

function savedSize() {
	try {
		const saved = window.localStorage.getItem(storageKey);
		const value = saved === null ? 50 : Number(saved);
		return Number.isFinite(value) && value >= 20 && value <= 80 ? value : 50;
	} catch {
		return 50;
	}
}

type Drag = { pointerId: number; coordinate: number; size: number; available: number; direction: number };
type LatexSplitPanesProps = { source: ReactNode; preview: ReactNode };

/** Keep native PDF frames from taking the pointer while the divider is dragged. */
export function LatexSplitPanes({ source, preview }: LatexSplitPanesProps) {
	const container = useRef<HTMLDivElement>(null);
	const divider = useRef<HTMLDivElement>(null);
	const drag = useRef<Drag | null>(null);
	const sourceId = useId();
	const previewId = useId();
	const horizontal = useSyncExternalStore(subscribeToLayout, isDesktop, () => false);
	const [preferredSize, setPreferredSize] = useState(savedSize);
	const [available, setAvailable] = useState(0);
	const [resizing, setResizing] = useState(false);
	// Keep each desktop pane at least 320px, and each stacked pane at least 180px where space permits.
	const minimum = Math.min(50, Math.max(20, available > 0 ? (horizontal ? 320 : 180) / available * 100 : 20));
	const maximum = 100 - minimum;
	const size = clamp(preferredSize, minimum, maximum);
	const sourcePercent = Math.round(size);
	const previewPercent = Math.round(100 - size);

	useEffect(() => {
		const root = container.current;
		const handle = divider.current;
		if (!root || !handle) return;
		const measure = () => {
			const box = root.getBoundingClientRect();
			const grip = handle.getBoundingClientRect();
			setAvailable(Math.max(0, horizontal ? box.width - grip.width : box.height - grip.height));
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(root);
		return () => observer.disconnect();
	}, [horizontal]);

	useEffect(() => {
		if (resizing) return;
		try { window.localStorage.setItem(storageKey, String(preferredSize)); }
		catch { /* Resizing still works when browser storage is unavailable. */ }
	}, [preferredSize, resizing]);

	const resize = (next: number) => setPreferredSize(clamp(next, minimum, maximum));
	const startDrag = (event: PointerEvent<HTMLDivElement>) => {
		if (event.button !== 0 || !event.isPrimary || available <= 0) return;
		event.preventDefault();
		event.currentTarget.focus({ preventScroll: true });
		event.currentTarget.setPointerCapture(event.pointerId);
		drag.current = {
			pointerId: event.pointerId,
			coordinate: horizontal ? event.clientX : event.clientY,
			size,
			available,
			direction: horizontal && container.current && getComputedStyle(container.current).direction === "rtl" ? -1 : 1,
		};
		setResizing(true);
	};
	const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
		const current = drag.current;
		if (!current || current.pointerId !== event.pointerId) return;
		const delta = (horizontal ? event.clientX : event.clientY) - current.coordinate;
		resize(current.size + delta * current.direction / current.available * 100);
	};
	const stopDrag = (event: PointerEvent<HTMLDivElement>) => {
		if (drag.current?.pointerId !== event.pointerId) return;
		drag.current = null;
		setResizing(false);
		if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
	};
	const resizeWithKeys = (event: KeyboardEvent<HTMLDivElement>) => {
		const direction = horizontal && container.current && getComputedStyle(container.current).direction === "rtl" ? -1 : 1;
		const step = event.shiftKey ? 10 : 2;
		if (event.key === "Home") resize(minimum);
		else if (event.key === "End") resize(maximum);
		else if (event.key === "Enter") resize(50);
		else if (event.key === (horizontal ? "ArrowLeft" : "ArrowUp")) resize(size - step * direction);
		else if (event.key === (horizontal ? "ArrowRight" : "ArrowDown")) resize(size + step * direction);
		else return;
		event.preventDefault();
	};

	return (
		<div
			ref={container}
			className="relative grid min-h-0 min-w-0 flex-1 grid-cols-1 grid-rows-[minmax(0,var(--latex-source-size))_0.75rem_minmax(0,var(--latex-preview-size))] lg:grid-cols-[minmax(0,var(--latex-source-size))_0.75rem_minmax(0,var(--latex-preview-size))] lg:grid-rows-1"
			style={{ "--latex-source-size": `${size}fr`, "--latex-preview-size": `${100 - size}fr` } as CSSProperties}
		>
			<div id={sourceId} className="flex min-h-0 min-w-0 overflow-hidden">{source}</div>
			<div
				ref={divider}
				role="separator"
				tabIndex={0}
				aria-label={t`Resize LaTeX source and PDF preview`}
				aria-controls={`${sourceId} ${previewId}`}
				aria-orientation={horizontal ? "vertical" : "horizontal"}
				aria-valuemin={Math.round(minimum)}
				aria-valuemax={Math.round(maximum)}
				aria-valuenow={sourcePercent}
				aria-valuetext={t`Source ${sourcePercent}%, PDF ${previewPercent}%`}
				title={t`Drag to resize. Use arrow keys, or double-click to reset.`}
				className="group z-10 flex cursor-row-resize touch-none items-center justify-center border-y border-line bg-sunken select-none hover:bg-accent-soft focus-visible:bg-accent-soft focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2 lg:cursor-col-resize lg:border-x lg:border-y-0"
				onPointerDown={startDrag}
				onPointerMove={moveDrag}
				onPointerUp={stopDrag}
				onPointerCancel={stopDrag}
				onLostPointerCapture={stopDrag}
				onKeyDown={resizeWithKeys}
				onDoubleClick={() => resize(50)}
			>
				<span aria-hidden className="h-1 w-8 rounded-full bg-line-2 group-hover:bg-accent group-focus-visible:bg-accent lg:h-8 lg:w-1" />
			</div>
			<div id={previewId} className={`flex min-h-0 min-w-0 overflow-hidden ${resizing ? "pointer-events-none" : ""}`}>{preview}</div>
			{resizing && <div aria-hidden className={`fixed inset-0 z-50 select-none ${horizontal ? "cursor-col-resize" : "cursor-row-resize"}`} />}
		</div>
	);
}
