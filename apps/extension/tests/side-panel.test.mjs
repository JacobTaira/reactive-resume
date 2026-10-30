import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createApplicationWindowService } from "../src/application-window.js";

function fixture() {
	const storage = {};
	const source = { id: 7, windowId: 1, url: "https://careers.example/apply/one" };
	const other = { id: 8, windowId: 2, url: "https://other.example/apply/two" };
	const tabs = new Map([[source.id, source], [other.id, other]]);
	const contexts = new Map();
	const calls = [];
	let active = other;
	let release;
	let blocked = null;
	let queryCount = 0;
	const chrome = {
		runtime: {
			id: "fixture", getURL: (path) => `chrome-extension://fixture/${path}`,
			getContexts: async (filter) => {
				assert.deepEqual(filter.contextTypes, ["SIDE_PANEL"]);
				return filter.documentIds.map((id) => contexts.get(id)).filter(Boolean);
			},
		},
		storage: { session: {
			get: async (defaults) => {
				if (blocked) await blocked;
				return Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, structuredClone(storage[key] ?? value)]));
			},
			set: async (value) => Object.assign(storage, structuredClone(value)),
		} },
		tabs: {
			get: async (id) => { if (!tabs.has(id)) throw new Error("Tab closed"); return structuredClone(tabs.get(id)); },
			query: async () => { queryCount++; return [active]; },
		},
		sidePanel: {
			setOptions: (value) => { calls.push(["options", value]); return Promise.resolve(); },
			open: (value) => { calls.push(["open", value]); return Promise.resolve(); },
		},
	};
	const service = createApplicationWindowService(chrome);
	function panelSender(documentId = "native-panel") {
		const options = [...calls].reverse().find(([name]) => name === "options")[1];
		const url = `chrome-extension://fixture/${options.path}`;
		const tab = tabs.get(options.tabId);
		contexts.set(documentId, { contextType: "SIDE_PANEL", documentId, documentUrl: url, windowId: tab.windowId });
		return { id: "fixture", url, documentId };
	}
	return { service, chrome, source, other, storage, tabs, calls, contexts, panelSender,
		holdStorage: () => { blocked = new Promise((resolve) => { release = resolve; }); },
		releaseStorage: () => { blocked = null; release?.(); },
		activate: (tab) => { active = tab; }, get queryCount() { return queryCount; } };
}

test("first action click synchronously configures the bound tab path before opening the native panel", async () => {
	const f = fixture();
	f.holdStorage();
	const opening = f.service.openSidePanel(f.source);
	assert.equal(f.calls.length, 2);
	assert.equal(f.calls[0][0], "options");
	assert.equal(f.calls[0][1].tabId, 7);
	assert.equal(f.calls[0][1].enabled, true);
	assert.match(f.calls[0][1].path, /^popup\.html\?mode=sidepanel&context=/u);
	assert.deepEqual(f.calls[1], ["open", { tabId: 7 }]);
	const from = f.panelSender();
	// Panel initialization can resolve its original tab even before the session
	// storage round trip completes; it never queries the currently active tab.
	const initial = await f.service.resolveTab(from);
	assert.equal(initial.tab.id, 7);
	assert.equal(initial.viewMode, "sidepanel");
	assert.equal(initial.windowMode, false);
	assert.equal(f.queryCount, 0);
	f.releaseStorage(); await opening;
});

test("native side panel without sender.tab retains its source through focus changes and a worker restart", async () => {
	const f = fixture();
	await f.service.openSidePanel(f.source);
	const from = f.panelSender();
	assert.equal(from.tab, undefined);
	f.activate(f.other);
	const restarted = createApplicationWindowService(f.chrome);
	assert.equal((await restarted.resolveTab(from)).tab.id, 7);
	assert.equal(f.queryCount, 0);
});

test("copied URLs, wrong documents, wrong native windows and cross-mode tokens are rejected", async () => {
	const f = fixture();
	await f.service.openSidePanel(f.source);
	const from = f.panelSender();
	await assert.rejects(f.service.resolveTab({ ...from, documentId: "unknown" }), /linked Chrome side panel/u);
	await assert.rejects(f.service.resolveTab({ ...from, documentId: undefined }), /extension button/u);
	const context = f.contexts.get(from.documentId);
	f.contexts.set(from.documentId, { ...context, contextType: "TAB" });
	await assert.rejects(f.service.resolveTab(from), /linked Chrome side panel/u);
	f.contexts.set(from.documentId, { ...context, windowId: 999 });
	await assert.rejects(f.service.resolveTab(from), /linked Chrome side panel/u);
	f.contexts.set(from.documentId, context);
	await assert.rejects(f.service.resolveTab({ ...from, url: from.url.replace("mode=sidepanel", "mode=window") }), /context does not match/u);
	await assert.rejects(f.service.resolveTab({ ...from, url: "chrome-extension://fixture/popup.html?mode=sidepanel" }), /not linked/u);
});

test("closed, moved and cross-origin source tabs fail closed rather than adopting another active form", async () => {
	const f = fixture();
	await f.service.openSidePanel(f.source);
	const from = f.panelSender();
	f.source.windowId = 2;
	await assert.rejects(f.service.resolveTab(from), /another browser window/u);
	f.source.windowId = 1; f.source.url = "https://different-employer.example/apply";
	await assert.rejects(f.service.resolveTab(from), /another website/u);
	f.tabs.delete(7);
	await assert.rejects(f.service.resolveTab(from), /closed/u);
	assert.equal(f.queryCount, 0);
});

test("each application tab gets its own panel and repeated clicks retire only that tab's old panel context", async () => {
	const f = fixture();
	await f.service.openSidePanel(f.source);
	const first = f.panelSender("source-first");
	await f.service.openSidePanel(f.other);
	const second = f.panelSender("other-panel");
	assert.equal((await f.service.resolveTab(first)).tab.id, 7);
	assert.equal((await f.service.resolveTab(second)).tab.id, 8);
	await f.service.openSidePanel(f.source);
	const refreshed = f.panelSender("source-refreshed");
	await assert.rejects(f.service.resolveTab(first), /no longer linked/u);
	assert.equal((await f.service.resolveTab(second)).tab.id, 8);
	assert.equal((await f.service.resolveTab(refreshed)).tab.id, 7);
	assert.equal(Object.keys(f.storage.autofillApplicationWindows).length, 2);
});

test("panel configuration and permission failures invalidate the new context", async () => {
	const f = fixture();
	f.chrome.sidePanel.open = () => Promise.reject(new Error("User activation expired"));
	await assert.rejects(f.service.openSidePanel(f.source), /User activation expired/u);
	assert.deepEqual(f.storage.autofillApplicationWindows, {});
	await assert.rejects(f.service.openSidePanel({ id: 7, windowId: 1, url: "chrome://extensions" }), /ordinary job application/u);
	assert.equal(f.calls.length, 1);
});

test("the manifest uses the native panel action with no popup, global panel or expanded host grant", async () => {
	const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
	assert.ok(manifest.permissions.includes("sidePanel"));
	assert.equal(manifest.action.default_popup, undefined);
	assert.equal(manifest.side_panel, undefined);
	assert.equal(manifest.permissions.includes("tabs"), false);
	assert.equal(manifest.host_permissions.includes("<all_urls>"), false);
});
