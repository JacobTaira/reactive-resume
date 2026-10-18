// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { i18n } from "@lingui/core";
import { LatexSplitPanes } from "./split-panes";

const storageKey = "reactive-resume:latex-source-pane-size";
let desktop = true;

beforeEach(() => {
	vi.restoreAllMocks();
	i18n.load("en", {});
	i18n.activate("en");
	window.localStorage.clear();
	desktop = true;
	vi.stubGlobal("matchMedia", () => ({ matches: desktop, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
	vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
		const divider = this.getAttribute("role") === "separator";
		return DOMRect.fromRect({ width: divider && desktop ? 12 : 1212, height: divider && !desktop ? 12 : 812 });
	});
});

function openPanes() {
	const result = render(<LatexSplitPanes source={<div>Source</div>} preview={<iframe title="Preview" />} />);
	const divider = screen.getByRole("separator");
	const captured = new Set<number>();
	const capture = vi.fn((pointer: number) => { captured.add(pointer); });
	const release = vi.fn((pointer: number) => { captured.delete(pointer); });
	Object.assign(divider, {
		setPointerCapture: capture,
		hasPointerCapture: (pointer: number) => captured.has(pointer),
		releasePointerCapture: release,
	});
	return { ...result, divider, capture, release };
}

it("supports keyboard resizing, sensible pane minimums, and resetting the divider", () => {
	const { divider } = openPanes();
	expect(divider).toHaveAttribute("aria-orientation", "vertical");
	expect(divider).toHaveAttribute("aria-valuenow", "50");
	fireEvent.keyDown(divider, { key: "ArrowRight", shiftKey: true });
	expect(divider).toHaveAttribute("aria-valuenow", "60");
	fireEvent.keyDown(divider, { key: "ArrowLeft" });
	expect(divider).toHaveAttribute("aria-valuenow", "58");
	fireEvent.keyDown(divider, { key: "End" });
	expect(divider).toHaveAttribute("aria-valuenow", "73");
	fireEvent.keyDown(divider, { key: "Home" });
	expect(divider).toHaveAttribute("aria-valuenow", "27");
	fireEvent.doubleClick(divider);
	expect(divider).toHaveAttribute("aria-valuenow", "50");
});

it("captures pointer drags across the PDF and remembers the final size when reopened", () => {
	const view = openPanes();
	fireEvent.pointerDown(view.divider, { pointerId: 1, isPrimary: true, button: 0, clientX: 600 });
	expect(view.capture).toHaveBeenCalledWith(1);
	expect(screen.getByTitle("Preview").parentElement).toHaveClass("pointer-events-none");
	fireEvent.pointerMove(view.divider, { pointerId: 1, clientX: 840 });
	expect(view.divider).toHaveAttribute("aria-valuenow", "70");
	fireEvent.pointerUp(view.divider, { pointerId: 1 });
	expect(view.release).toHaveBeenCalledWith(1);
	expect(screen.getByTitle("Preview").parentElement).not.toHaveClass("pointer-events-none");
	expect(window.localStorage.getItem(storageKey)).toBe("70");
	view.unmount();
	expect(openPanes().divider).toHaveAttribute("aria-valuenow", "70");
});

it("releases the PDF after canceled drags and ignores secondary pointers", () => {
	const { divider, capture } = openPanes();
	fireEvent.pointerDown(divider, { pointerId: 1, isPrimary: false, button: 0, clientX: 600 });
	expect(capture).not.toHaveBeenCalled();
	fireEvent.pointerDown(divider, { pointerId: 2, isPrimary: true, button: 0, clientX: 600 });
	fireEvent.pointerMove(divider, { pointerId: 3, clientX: 840 });
	expect(divider).toHaveAttribute("aria-valuenow", "50");
	fireEvent.pointerCancel(divider, { pointerId: 2 });
	expect(screen.getByTitle("Preview").parentElement).not.toHaveClass("pointer-events-none");
	fireEvent.pointerMove(divider, { pointerId: 2, clientX: 840 });
	expect(divider).toHaveAttribute("aria-valuenow", "50");
});

it("uses vertical resizing and arrow keys when the panes are stacked", () => {
	desktop = false;
	const { divider } = openPanes();
	expect(divider).toHaveAttribute("aria-orientation", "horizontal");
	fireEvent.keyDown(divider, { key: "ArrowDown", shiftKey: true });
	expect(divider).toHaveAttribute("aria-valuenow", "60");
	fireEvent.keyDown(divider, { key: "ArrowLeft" });
	expect(divider).toHaveAttribute("aria-valuenow", "60");
	fireEvent.pointerDown(divider, { pointerId: 1, isPrimary: true, button: 0, clientY: 400 });
	fireEvent.pointerMove(divider, { pointerId: 1, clientY: 240 });
	expect(divider).toHaveAttribute("aria-valuenow", "40");
	fireEvent.pointerUp(divider, { pointerId: 1 });
});

it("ignores invalid saved sizes and remains usable when storage is blocked", () => {
	window.localStorage.setItem(storageKey, "NaN");
	const view = openPanes();
	expect(view.divider).toHaveAttribute("aria-valuenow", "50");
	view.unmount();
	vi.spyOn(window.localStorage, "getItem").mockImplementation(() => { throw new Error("Storage blocked"); });
	vi.spyOn(window.localStorage, "setItem").mockImplementation(() => { throw new Error("Storage blocked"); });
	const next = openPanes();
	fireEvent.keyDown(next.divider, { key: "ArrowRight" });
	expect(next.divider).toHaveAttribute("aria-valuenow", "52");
});
