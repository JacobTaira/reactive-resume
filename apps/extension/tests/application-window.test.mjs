import assert from "node:assert/strict";
import test from "node:test";
import { createApplicationWindowService, mountApplicationWindow } from "../src/application-window.js";

const sender = { id: "fixture", url: "chrome-extension://fixture/popup.html" };

function fixture() {
	const session = {};
	const source = { id: 7, windowId: 1, url: "https://careers.example/apply/one" };
	const other = { id: 8, windowId: 2, url: "https://other.example/apply/two" };
	const tabs = new Map([[7, source], [8, other]]);
	let active = source;
	let nextId = 20;
	const created = [], focused = [], updated = [], reloaded = [];
	const chrome = {
		runtime: { id: "fixture", getURL: (path) => `chrome-extension://fixture/${path.replace(/^\//u, "")}` },
		storage: { session: {
			get: async (defaults) => Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, structuredClone(session[key] ?? value)])),
			set: async (value) => Object.assign(session, structuredClone(value)),
		} },
		tabs: {
			query: async (query) => query.windowId === undefined ? (active ? [structuredClone(active)] : []) : [...tabs.values()].filter((tab) => tab.windowId === query.windowId),
			get: async (id) => { if (!tabs.has(id)) throw new Error("No such tab"); return structuredClone(tabs.get(id)); },
			reload: async (id) => { if (!tabs.has(id)) throw new Error("No such tab"); reloaded.push(id); },
			update: async (id, values) => {
				const tab = tabs.get(id);
				if (!tab) throw new Error("No such tab");
				Object.assign(tab, values); updated.push({ id, ...values }); return structuredClone(tab);
			},
		},
		windows: {
			create: async (options) => {
				const id = ++nextId;
				const tab = { id: id + 100, windowId: id, url: options.url };
				tabs.set(tab.id, tab); active = tab; created.push(options);
				return { id, tabs: [structuredClone(tab)] };
			},
			update: async (id, values) => { focused.push({ id, ...values }); return { id }; },
		},
	};
	const service = createApplicationWindowService(chrome);
	const expected = () => ({ tabId: source.id, tabUrl: source.url });
	const boundSender = () => {
		const url = created.at(-1).url;
		const tab = [...tabs.values()].find((tab) => tab.url === url);
		return { ...sender, url, tab: structuredClone(tab) };
	};
	return { service, chrome, source, other, tabs, session, created, focused, updated, reloaded, expected, boundSender,
		activate: (tab) => { active = tab; } };
}

test("opening creates a native resizable window with a session-owned employer binding", async () => {
	const f = fixture();
	const result = await f.service.open(sender, f.expected());
	assert.equal(f.created.length, 1);
	assert.equal(f.created[0].type, "popup");
	assert.equal(f.created[0].width, 520);
	assert.equal(f.created[0].height, 760);
	assert.equal(result.sourceTabId, 7);
	const url = new URL(f.created[0].url);
	assert.equal(url.pathname, "/popup.html");
	assert.equal(url.searchParams.get("mode"), "window");
	assert.ok(url.searchParams.get("context"));
	assert.equal(url.searchParams.has("tabId"), false);
	assert.equal(JSON.stringify(f.session).includes("apiKey"), false);
});

test("switching focused browser windows never retargets the detached application", async () => {
	const f = fixture();
	await f.service.open(sender, f.expected());
	const from = f.boundSender();
	f.activate(f.other);
	assert.equal((await f.service.resolveTab(from)).tab.id, 7);
	await f.service.showSource(from);
	assert.deepEqual(f.updated.at(-1), { id: 7, active: true });
	assert.deepEqual(f.focused.at(-1), { id: 1, focused: true });
});

test("a new worker restores the same binding and reopening reuses its window", async () => {
	const f = fixture();
	const original = await f.service.open(sender, f.expected());
	const nextWorker = createApplicationWindowService(f.chrome);
	assert.equal((await nextWorker.resolveTab(f.boundSender())).tab.id, 7);
	f.activate(f.source);
	assert.equal((await nextWorker.open(sender, f.expected())).windowId, original.windowId);
	assert.equal(f.created.length, 1);
	assert.equal(f.focused.at(-1).id, original.windowId);
	assert.equal(f.reloaded.at(-1), f.boundSender().tab.id);
});

test("different employer tabs get independent bindings rather than adopting each other's window", async () => {
	const f = fixture();
	await f.service.open(sender, f.expected());
	const first = f.boundSender();
	f.activate(f.other);
	await f.service.open(sender, { tabId: 8, tabUrl: f.other.url });
	const second = f.boundSender();
	assert.equal(f.created.length, 2);
	assert.equal((await f.service.resolveTab(first)).tab.id, 7);
	assert.equal((await f.service.resolveTab(second)).tab.id, 8);
});

test("closed and cross-origin source tabs fail closed without adopting the active tab", async () => {
	const f = fixture();
	await f.service.open(sender, f.expected());
	const from = f.boundSender();
	f.activate(f.other);
	f.source.url = "https://another-employer.example/apply";
	await assert.rejects(f.service.resolveTab(from), /another website/u);
	f.tabs.delete(7);
	await assert.rejects(f.service.resolveTab(from), /closed/u);
});

test("same-origin navigation resolves the current page but explicit reopening rotates the old context", async () => {
	const f = fixture();
	await f.service.open(sender, f.expected());
	const old = f.boundSender();
	f.source.url = "https://careers.example/apply/one/education";
	assert.equal((await f.service.resolveTab(old)).tab.url, f.source.url);
	f.activate(f.source);
	await f.service.open(sender, f.expected());
	assert.equal(f.created.length, 1);
	await assert.rejects(f.service.resolveTab(old), /no longer linked/u);
	const record = Object.entries(f.session.autofillApplicationWindows)[0];
	const reloaded = { ...old, url: f.tabs.get(old.tab.id).url };
	assert.equal(new URL(reloaded.url).searchParams.get("context"), record[0]);
	assert.equal((await f.service.resolveTab(reloaded)).tab.url, f.source.url);
});

test("forged, copied, stale and missing binding contexts cannot direct a detached window", async () => {
	const f = fixture();
	await f.service.open(sender, f.expected());
	const from = f.boundSender();
	await assert.rejects(f.service.resolveTab({ ...from, url: "chrome-extension://fixture/popup.html?mode=window" }), /not linked/u);
	await assert.rejects(f.service.resolveTab({ ...from, url: "chrome-extension://fixture/popup.html?mode=window&context=guessed&tabId=8" }), /no longer linked/u);
	await assert.rejects(f.service.resolveTab({ ...from, tab: { id: 999 } }), /Open in window/u);
	f.activate(f.other);
	await assert.rejects(f.service.open(sender, f.expected()), /application tab changed/u);
});

test("normal settings can load without an ordinary application tab", async () => {
	const f = fixture();
	f.activate(null);
	assert.equal((await f.service.resolveTab(sender, { allowNonWeb: true })).tab, undefined);
	await assert.rejects(f.service.resolveTab(sender), /ordinary browser tab/u);
	f.activate({ id: 9, url: "chrome-extension://fixture/autofill.html" });
	assert.equal((await f.service.resolveTab({ ...sender, url: "chrome-extension://fixture/autofill.html" }, { allowNonWeb: true })).tab.id, 9);
});

function pageFixture({ windowMode = false } = {}) {
	const listeners = new Map();
	const element = () => ({ disabled: true, dataset: {}, setAttribute() {}, addEventListener(type, listener) { listeners.set(type, listener); } });
	const button = element(), context = element(), workspace = element(), message = element();
	const calls = [], updated = [], removed = [];
	let closed = 0, reloaded = 0, saved = 0;
	const document = { body: element(), getElementById: (id) => ({ "open-window": button, "source-context": context, workspace, message })[id],
		defaultView: { close: () => { closed++; }, location: { reload: () => { reloaded++; } } } };
	const state = { windowMode, draftContext: { tabId: 7, tabUrl: "https://careers.example/apply/one" } };
	const chromeApi = { runtime: { sendMessage: async (value) => { calls.push(value); return { ok: true }; } },
		tabs: { onUpdated: { addListener: (fn) => updated.push(fn) }, onRemoved: { addListener: (fn) => removed.push(fn) } } };
	mountApplicationWindow({ document, chromeApi, state, beforeOpen: async () => { saved++; } });
	return { document, state, button, context, workspace, message, calls, updated, removed, click: () => listeners.get("click")(),
		get closed() { return closed; }, get reloaded() { return reloaded; }, get saved() { return saved; } };
}

test("opening from the toolbar saves its draft before transferring to the persistent window", async () => {
	const f = pageFixture();
	assert.equal(f.button.textContent, "Open in window");
	await f.click();
	assert.equal(f.saved, 1);
	assert.deepEqual(f.calls, [{ type: "autofill-open-window", tabId: 7, tabUrl: f.state.draftContext.tabUrl }]);
	assert.equal(f.closed, 1);
});

test("detached navigation reloads the draft context and a closed source disables the workspace", async () => {
	const f = pageFixture({ windowMode: true });
	assert.equal(f.document.body.dataset.mode, "window");
	assert.equal(f.button.textContent, "Show application");
	await f.click();
	assert.deepEqual(f.calls, [{ type: "autofill-show-source" }]);
	assert.equal(f.closed, 0);
	f.updated[0](8, { url: "https://other.example/new" }, {});
	assert.equal(f.reloaded, 0);
	f.updated[0](7, { url: "https://careers.example/apply/one/next" }, {});
	assert.equal(f.reloaded, 1);
	f.removed[0](7);
	assert.equal(f.workspace.disabled, true);
	assert.equal(f.button.disabled, true);
	assert.match(f.context.textContent, /closed/u);
});
