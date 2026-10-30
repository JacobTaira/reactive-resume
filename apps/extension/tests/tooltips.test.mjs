import assert from "node:assert/strict";
import test from "node:test";
import { mountTooltips } from "../src/tooltips.js";

class Target {
	constructor() { this.listeners = new Map(); }
	addEventListener(type, listener) {
		if (!this.listeners.has(type)) this.listeners.set(type, new Set());
		this.listeners.get(type).add(listener);
	}
	removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
	emit(type, properties = {}) {
		for (const listener of this.listeners.get(type) || []) listener({ currentTarget: this, ...properties });
	}
}

class Element extends Target {
	constructor(attributes = {}, rect = { left: 20, top: 50, width: 160, height: 36 }) {
		super();
		this.attributes = new Map(Object.entries(attributes));
		this.rect = rect;
		this.children = [];
		this.hidden = false;
		this.isConnected = true;
		this.style = {};
	}
	getAttribute(name) { return this.attributes.get(name) ?? null; }
	setAttribute(name, value) { this.attributes.set(name, value); }
	removeAttribute(name) { this.attributes.delete(name); }
	append(element) { this.children.push(element); element.parent = this; }
	contains(element) { return this === element || this.children.some((child) => child.contains(element)); }
	remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }
	getBoundingClientRect() { return { ...this.rect, bottom: this.rect.top + this.rect.height, right: this.rect.left + this.rect.width }; }
}

function fixture() {
	let now = 0;
	let nextTimer = 0;
	const timers = new Map();
	const view = Object.assign(new Target(), {
		innerWidth: 440, innerHeight: 600,
		setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, at: now + delay }); return id; },
		clearTimeout(id) { timers.delete(id); },
	});
	const first = new Element({ "data-tooltip": "Load prepared jobs into Resume source.", "aria-describedby": "existing-help" });
	const second = new Element({ "data-tooltip": "Preview the selected resume and proposed answers." });
	const document = Object.assign(new Target(), {
		defaultView: view, documentElement: { clientWidth: 440, clientHeight: 600 }, body: new Element(),
		querySelectorAll: () => [first, second],
		getElementById(id) { return this.body.children.find((element) => element.id === id) || null; },
		createElement: () => new Element({}, { left: 0, top: 0, width: 300, height: 86 }),
	});
	const dispose = mountTooltips({ document });
	const tooltip = document.body.children[0];
	const advance = (milliseconds) => {
		const until = now + milliseconds;
		while (true) {
			const entry = [...timers.entries()].filter(([, value]) => value.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
			if (!entry) break;
			const [id, timer] = entry;
			now = timer.at; timers.delete(id); timer.callback();
		}
		now = until;
	};
	return { first, second, document, view, tooltip, timers, advance, dispose };
}

test("hover waits 1.2 seconds and dismissal preserves existing accessible descriptions", () => {
	const f = fixture();
	f.first.emit("mouseenter");
	f.advance(1199);
	assert.equal(f.tooltip.hidden, true);
	f.advance(1);
	assert.equal(f.tooltip.hidden, false);
	assert.equal(f.tooltip.textContent, f.first.getAttribute("data-tooltip"));
	assert.equal(f.tooltip.getAttribute("role"), "tooltip");
	assert.equal(f.first.getAttribute("aria-describedby"), `existing-help ${f.tooltip.id}`);
	f.first.emit("mouseleave");
	f.advance(100);
	assert.equal(f.tooltip.hidden, true);
	assert.equal(f.first.getAttribute("aria-describedby"), "existing-help");
});

test("leaving before the delay cancels opening and a new target gets its own full delay", () => {
	const f = fixture();
	f.first.emit("mouseenter"); f.advance(900); f.first.emit("mouseleave");
	f.advance(1200);
	assert.equal(f.tooltip.hidden, true);
	assert.equal(f.timers.size, 0);
	f.first.emit("mouseenter"); f.advance(900); f.second.emit("mouseenter");
	f.advance(1199);
	assert.equal(f.tooltip.hidden, true);
	f.advance(1);
	assert.equal(f.tooltip.textContent, f.second.getAttribute("data-tooltip"));
	assert.equal(f.first.getAttribute("aria-describedby"), "existing-help");
});

test("keyboard focus opens help without moving focus and Escape or blur dismisses it", () => {
	const f = fixture();
	f.document.activeElement = f.first;
	f.first.emit("focus"); f.advance(500); f.document.emit("keydown", { key: "Escape" }); f.advance(1200);
	assert.equal(f.tooltip.hidden, true);
	f.first.emit("focus"); f.advance(1200);
	assert.equal(f.tooltip.hidden, false);
	assert.equal(f.document.activeElement, f.first);
	f.document.emit("keydown", { key: "Escape" });
	assert.equal(f.tooltip.hidden, true);
	f.first.emit("focus"); f.advance(1200);
	f.first.setAttribute("aria-describedby", `existing-help ${f.tooltip.id} added-help`);
	f.first.emit("blur");
	assert.equal(f.tooltip.hidden, true);
	assert.equal(f.first.getAttribute("aria-describedby"), "existing-help added-help");
});

test("moving into the tooltip keeps its text readable until the pointer leaves it", () => {
	const f = fixture();
	f.first.emit("mouseenter"); f.advance(1200);
	f.first.emit("mouseleave"); f.advance(50); f.tooltip.emit("mouseenter"); f.advance(2000);
	assert.equal(f.tooltip.hidden, false);
	f.tooltip.emit("mouseleave");
	assert.equal(f.tooltip.hidden, true);
	assert.equal(f.first.getAttribute("aria-describedby"), "existing-help");
});

test("positioning fits the popup viewport and flips above controls near the bottom", () => {
	const f = fixture();
	f.first.rect = { left: 420, top: 570, width: 20, height: 30 };
	f.first.emit("mouseenter"); f.advance(1200);
	assert.equal(f.tooltip.style.left, "132px");
	assert.equal(f.tooltip.style.top, "476px");
	f.first.emit("mouseleave"); f.advance(100);
	f.first.rect = { left: 0, top: 0, width: 20, height: 20 };
	f.first.emit("focus"); f.advance(1200);
	assert.equal(f.tooltip.style.left, "8px");
	assert.equal(f.tooltip.style.top, "28px");
});

test("click, scrolling and resizing dismiss visible or pending help", () => {
	const f = fixture();
	for (const dismiss of [() => f.first.emit("click"), () => f.document.emit("scroll"), () => f.view.emit("resize")]) {
		f.first.emit("mouseenter"); f.advance(1200); dismiss();
		assert.equal(f.tooltip.hidden, true);
		f.first.emit("focus"); dismiss(); f.advance(1200);
		assert.equal(f.tooltip.hidden, true);
		assert.equal(f.timers.size, 0);
	}
});

test("detached controls and disposed popup listeners cannot revive tooltips", () => {
	const f = fixture();
	f.first.emit("mouseenter"); f.first.isConnected = false; f.advance(1200);
	assert.equal(f.tooltip.hidden, true);
	f.second.emit("focus"); f.dispose(); f.advance(1200);
	assert.equal(f.tooltip.isConnected, false);
	f.second.emit("mouseenter"); f.advance(1200);
	assert.equal(f.timers.size, 0);
});
