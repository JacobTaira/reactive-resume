import assert from "node:assert/strict";
import test from "node:test";
import { mountFeedback, mountTheme } from "../src/presentation.js";

class Events {
	constructor() { this.listeners = new Map(); }
	addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(listener); }
	removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
	async emit(type, event = {}) { for (const listener of this.listeners.get(type) || []) await listener(event); }
}

class Element extends Events {
	constructor(id = "") {
		super(); this.id = id; this.dataset = {}; this.attributes = new Map(); this.textContent = ""; this.hidden = false;
		this.disabled = false; this.isConnected = true; this.classWrites = 0;
		const classes = new Set();
		this.classList = {
			contains: (value) => classes.has(value),
			toggle: (value, force) => {
				const next = force ?? !classes.has(value);
				if (classes.has(value) !== next) { this.classWrites++; if (next) classes.add(value); else classes.delete(value); }
			},
			add: (value) => { if (!classes.has(value)) { this.classWrites++; classes.add(value); } },
			remove: (value) => { if (classes.delete(value)) this.classWrites++; },
		};
	}
	setAttribute(key, value) { this.attributes.set(key, value); }
	getAttribute(key) { return this.attributes.get(key) ?? null; }
	removeAttribute(key) { this.attributes.delete(key); }
	closest(selector) { return selector === "button" ? this : null; }
}

function fixture({ preference = null, dark = false, get = null, failSave = false } = {}) {
	const media = Object.assign(new Events(), { matches: dark });
	const changed = new Set();
	const writes = [];
	const storage = { extensionTheme: preference, autofillProfile: { firstName: "Example" } };
	const nodes = Object.fromEntries(["theme-toggle", "appearance-status", "message", "preview", "diagnostics"].map((id) => [id, new Element(id)]));
	let observer;
	const document = Object.assign(new Events(), {
		documentElement: new Element(), body: new Element(), getElementById: (id) => nodes[id] || null,
		defaultView: {
			matchMedia: (query) => query.includes("reduced-motion") ? { matches: true } : media,
			MutationObserver: class { constructor(callback) { this.notify = callback; observer = this; } observe() {} disconnect() { this.disconnected = true; } },
			requestAnimationFrame: () => { throw new Error("Reduced motion must suppress feedback animation."); },
		},
	});
	const chromeApi = { storage: {
		local: {
			get: get || (async () => structuredClone(storage)),
			set: async (values) => {
				if (failSave) throw new Error("Storage unavailable");
				writes.push(structuredClone(values));
				Object.assign(storage, values);
				for (const listener of changed) listener({ extensionTheme: { newValue: storage.extensionTheme } }, "local");
			},
		},
		onChanged: { addListener: (listener) => changed.add(listener), removeListener: (listener) => changed.delete(listener) },
	} };
	return { document, chromeApi, media, nodes, storage, writes, changed, notify: () => observer.notify() };
}

test("appearance follows the system until explicitly toggled and persists only its own preference", async () => {
	const f = fixture({ dark: true });
	const dispose = await mountTheme(f);
	assert.equal(f.document.documentElement.dataset.theme, "dark");
	assert.equal(f.nodes["theme-toggle"].getAttribute("aria-pressed"), "true");
	f.media.matches = false; await f.media.emit("change");
	assert.equal(f.document.documentElement.dataset.theme, "light");
	await f.nodes["theme-toggle"].emit("click");
	assert.equal(f.document.documentElement.dataset.theme, "dark");
	assert.deepEqual(f.writes, [{ extensionTheme: "dark" }]);
	assert.deepEqual(f.storage.autofillProfile, { firstName: "Example" });
	f.media.matches = false; await f.media.emit("change");
	assert.equal(f.document.documentElement.dataset.theme, "dark");
	dispose();
	assert.equal(f.changed.size, 0);
});

test("saved appearance overrides the system and syncs between extension pages without resetting data", async () => {
	const f = fixture({ preference: "light", dark: true });
	await mountTheme(f);
	assert.equal(f.document.documentElement.dataset.theme, "light");
	const notify = [...f.changed][0];
	notify({ autofillProfile: { newValue: {} } }, "local");
	assert.equal(f.document.documentElement.dataset.theme, "light");
	notify({ extensionTheme: { newValue: "dark" } }, "sync");
	assert.equal(f.document.documentElement.dataset.theme, "light");
	notify({ extensionTheme: { newValue: "dark" } }, "local");
	assert.equal(f.document.documentElement.dataset.theme, "dark");
	assert.equal(f.nodes["theme-toggle"].getAttribute("aria-label"), "Switch to light mode");
	notify({ extensionTheme: { newValue: null } }, "local");
	assert.equal(f.document.documentElement.dataset.theme, "dark");
	f.media.matches = false; await f.media.emit("change");
	assert.equal(f.document.documentElement.dataset.theme, "light");
	assert.deepEqual(f.writes, []);
});

test("a theme choice made during initial loading wins over the stale saved preference", async () => {
	let release;
	const f = fixture({ get: () => new Promise((resolve) => { release = resolve; }) });
	const mounting = mountTheme(f);
	await f.nodes["theme-toggle"].emit("click");
	release({ extensionTheme: "light" });
	await mounting;
	assert.equal(f.document.documentElement.dataset.theme, "dark");
	assert.deepEqual(f.writes, [{ extensionTheme: "dark" }]);
});

test("storage failures keep the chosen appearance usable and report that it was not saved", async () => {
	const f = fixture({ preference: "unexpected", failSave: true });
	await mountTheme(f);
	await f.nodes["theme-toggle"].emit("click");
	assert.equal(f.document.documentElement.dataset.theme, "dark");
	assert.equal(f.nodes["appearance-status"].hidden, false);
	assert.match(f.nodes["appearance-status"].textContent, /could not be saved/u);
	assert.deepEqual(f.writes, []);
});

test("concurrent popup actions each clear their own progress indicator when they finish", async () => {
	const f = fixture();
	const dispose = mountFeedback(f);
	const preview = f.nodes.preview, diagnostics = f.nodes.diagnostics;
	preview.disabled = true;
	await f.document.emit("click", { target: preview });
	assert.equal(preview.classList.contains("is-busy"), true);
	diagnostics.disabled = true;
	await f.document.emit("click", { target: diagnostics });
	assert.equal(diagnostics.getAttribute("aria-busy"), "true");
	const writes = preview.classWrites + diagnostics.classWrites;
	f.notify(); f.notify();
	assert.equal(preview.classWrites + diagnostics.classWrites, writes);
	preview.disabled = false; f.notify();
	assert.equal(preview.classList.contains("is-busy"), false);
	assert.equal(preview.getAttribute("aria-busy"), null);
	assert.equal(diagnostics.classList.contains("is-busy"), true);
	diagnostics.disabled = false; f.notify();
	assert.equal(diagnostics.classList.contains("is-busy"), false);
	assert.equal(diagnostics.getAttribute("aria-busy"), null);
	dispose();
});

test("empty results and guidance stay neutral while attention and confirmed outcomes remain distinct", () => {
	const f = fixture();
	mountFeedback(f);
	const message = f.nodes.message;
	for (const [text, expected] of [
		["No prepared jobs found. Prepare your saved jobs, then load again.", "neutral"],
		["0 fields filled or files selected. 0 need attention.", "neutral"],
		["1 fields filled or files selected. 2 need attention.", "attention"],
		["3 fields filled or files selected. 0 need attention.", "success"],
		["2 prepared jobs loaded. Choose a company and role.", "success"],
		["Loading the selected resume and reading this form…", "busy"],
	]) {
		message.textContent = text; f.notify();
		assert.equal(message.dataset.feedback, expected, text);
	}
	message.classList.add("error"); message.textContent = "The connection failed."; f.notify();
	assert.equal(message.dataset.feedback, "error");
});
