const STORAGE_KEY = "autofillApplicationWindows";

function viewContext(sender, extensionId) {
	const url = new URL(sender.url);
	if (url.protocol !== "chrome-extension:" || url.host !== extensionId || url.pathname !== "/popup.html") return null;
	const viewMode = url.searchParams.get("mode");
	if (!["window", "sidepanel"].includes(viewMode)) return null;
	const token = url.searchParams.get("context");
	if (!token) throw new Error("This assistant is not linked to an application. Click the extension button on the intended application again.");
	return { token, viewMode };
}

/** Session-owned bindings keep a detached window on its original employer tab. */
export function createApplicationWindowService(chromeApi) {
	let serial = Promise.resolve();
	const pendingPanels = new Map();
	const read = async () => (await chromeApi.storage.session.get({ [STORAGE_KEY]: {} }))[STORAGE_KEY];
	const save = (bindings) => chromeApi.storage.session.set({ [STORAGE_KEY]: bindings });
	const validTab = (tab) => tab && Number.isSafeInteger(tab.id) && /^https?:\/\//.test(tab.url || "");
	async function binding(sender) {
		const context = viewContext(sender, chromeApi.runtime.id);
		if (!context) return null;
		const { token, viewMode } = context;
		const record = pendingPanels.get(token) || (await read())[token];
		if (!record) throw new Error("This window is no longer linked to an application. Open the extension on the intended application again.");
		if ((record.viewMode || "window") !== viewMode) throw new Error("The application context does not match this assistant view.");
		if (viewMode === "sidepanel") {
			if (typeof sender.documentId !== "string" || !chromeApi.runtime.getContexts) throw new Error("Open the assistant from Chrome’s extension button on the application.");
			const contexts = await chromeApi.runtime.getContexts({ contextTypes: ["SIDE_PANEL"], documentIds: [sender.documentId] });
			const native = contexts.find((value) => value.contextType === "SIDE_PANEL" && value.documentId === sender.documentId && value.windowId === record.sourceWindowId);
			if (!native || native.documentUrl !== sender.url) throw new Error("This assistant must run in its linked Chrome side panel.");
		} else if (record.extensionTabId !== undefined && sender.tab?.id !== record.extensionTabId) {
			throw new Error("Open the linked application window using the extension’s Open in window button.");
		}
		return { token, ...record, viewMode };
	}
	async function resolveTab(sender, { allowNonWeb = false } = {}) {
		const record = await binding(sender);
		let tab;
		if (record) {
			try { tab = await chromeApi.tabs.get(record.sourceTabId); }
			catch { throw new Error("The linked application tab was closed. Open the extension on the intended application again."); }
			if (!validTab(tab) || new URL(tab.url).origin !== record.sourceOrigin) {
				throw new Error("The linked tab moved to another website. Open the extension on that application again to reconnect.");
			}
			if (record.viewMode === "sidepanel" && tab.windowId !== record.sourceWindowId) throw new Error("The application tab moved to another browser window. Click the extension button there to reconnect.");
		} else [tab] = await chromeApi.tabs.query({ active: true, currentWindow: true });
		if (!allowNonWeb && !validTab(tab)) throw new Error("Open the employer’s application form in an ordinary browser tab.");
		return { tab, windowMode: record?.viewMode === "window", viewMode: record?.viewMode || "popup" };
	}
	function openSidePanel(tab) {
		if (!validTab(tab) || !Number.isSafeInteger(tab.windowId)) return Promise.reject(new Error("Open an ordinary job application page, then click the extension button."));
		if (!chromeApi.sidePanel?.setOptions || !chromeApi.sidePanel?.open) return Promise.reject(new Error("Chrome’s side panel is unavailable. Update Chrome and reload the extension."));
		const token = crypto.randomUUID();
		const record = { viewMode: "sidepanel", sourceTabId: tab.id, sourceUrl: tab.url, sourceOrigin: new URL(tab.url).origin, sourceWindowId: tab.windowId };
		pendingPanels.set(token, record);
		const path = `popup.html?mode=sidepanel&context=${encodeURIComponent(token)}`;
		// Chrome requires open() in the original action-click stack. Both API calls
		// intentionally happen before any storage await; IPC order applies the
		// exact tab-specific path before opening it on the very first click.
		let configured, opened;
		try {
			configured = chromeApi.sidePanel.setOptions({ tabId: tab.id, path, enabled: true });
			opened = chromeApi.sidePanel.open({ tabId: tab.id });
		} catch (error) { pendingPanels.delete(token); return Promise.reject(error); }
		const persisted = serial.catch(() => {}).then(async () => {
			const bindings = await read();
			for (const [key, value] of Object.entries(bindings)) if (value.viewMode === "sidepanel" && value.sourceTabId === tab.id) delete bindings[key];
			bindings[token] = record; await save(bindings);
		});
		serial = persisted;
		return Promise.all([configured, opened, persisted]).then(() => {
			pendingPanels.delete(token);
			return { sourceTabId: tab.id, sourceUrl: tab.url };
		}, async (error) => {
			pendingPanels.delete(token);
			await persisted.catch(() => {});
			const cleanup = serial.catch(() => {}).then(async () => { const bindings = await read(); delete bindings[token]; await save(bindings); });
			serial = cleanup; await cleanup;
			throw error;
		});
	}
	async function open(sender, expected = {}) {
		const run = serial.catch(() => {}).then(async () => {
			const { tab } = await resolveTab(sender);
			if (expected.tabId !== tab.id || expected.tabUrl !== tab.url) {
				throw new Error("The application tab changed. Reopen the extension on the intended form before opening its window.");
			}
			const bindings = await read();
			const entries = Object.entries(bindings).filter(([, value]) => value.sourceTabId === tab.id && value.viewMode !== "sidepanel");
			let previous;
			for (const [token, record] of entries) {
				try {
					const existing = await chromeApi.tabs.get(record.extensionTabId);
					const url = new URL(existing.url);
					if (existing.windowId !== record.windowId || url.protocol !== "chrome-extension:" || url.host !== chromeApi.runtime.id
						|| url.pathname !== "/popup.html" || url.searchParams.get("context") !== token) throw new Error("Window changed");
					previous = record;
					if (record.sourceOrigin === new URL(tab.url).origin && record.sourceUrl === tab.url) {
						// The toolbar may have just saved a different PDF or saved-job
						// selection. Reload so the existing window adopts that draft.
						await chromeApi.tabs.reload(record.extensionTabId);
						await chromeApi.windows.update(record.windowId, { focused: true, state: "normal" });
						return { sourceTabId: tab.id, sourceUrl: tab.url, windowId: record.windowId };
					}
				} catch { previous = undefined; /* Closed windows are replaced; never adopt an unrelated window. */ }
				delete bindings[token];
			}
			const token = crypto.randomUUID();
			const url = new URL(chromeApi.runtime.getURL("popup.html"));
			url.searchParams.set("mode", "window"); url.searchParams.set("context", token);
			bindings[token] = { viewMode: "window", sourceTabId: tab.id, sourceUrl: tab.url, sourceOrigin: new URL(tab.url).origin };
			await save(bindings);
			try {
				let opened;
				if (previous) {
					await chromeApi.tabs.update(previous.extensionTabId, { url: url.href });
					opened = await chromeApi.windows.update(previous.windowId, { focused: true, state: "normal" });
					opened = { ...opened, id: previous.windowId, tabs: [{ id: previous.extensionTabId }] };
				} else opened = await chromeApi.windows.create({ url: url.href, type: "popup", width: 520, height: 760, focused: true });
				const extensionTabId = opened.tabs?.[0]?.id ?? (await chromeApi.tabs.query({ windowId: opened.id }))[0]?.id;
				if (!Number.isSafeInteger(opened.id) || !Number.isSafeInteger(extensionTabId)) throw new Error("The application window could not be opened.");
				bindings[token] = { ...bindings[token], windowId: opened.id, extensionTabId };
				await save(bindings);
				return { sourceTabId: tab.id, sourceUrl: tab.url, windowId: opened.id };
			} catch (error) {
				delete bindings[token]; await save(bindings); throw error;
			}
		});
		serial = run;
		return run;
	}
	async function showSource(sender) {
		if (!(await binding(sender))) throw new Error("This action is available from a linked application window.");
		const { tab } = await resolveTab(sender);
		await chromeApi.tabs.update(tab.id, { active: true });
		if (Number.isSafeInteger(tab.windowId)) await chromeApi.windows.update(tab.windowId, { focused: true });
		return { message: "Application tab brought to the front." };
	}
	return { resolveTab, open, showSource, openSidePanel };
}

/** Native Chrome windows remain open on blur and resize with the OS window frame. */
export function mountApplicationWindow({ document, chromeApi, state, beforeOpen = async () => {} }) {
	const button = document.getElementById("open-window");
	if (!button) return;
	const view = document.defaultView;
	const { tabId, tabUrl } = state.draftContext;
	const mode = state.viewMode || (state.windowMode ? "window" : "popup");
	const detached = mode === "window";
	const bound = detached || mode === "sidepanel";
	document.body.dataset.mode = mode;
	const label = button.querySelector?.("span") || button;
	label.textContent = detached ? "Show application" : "Open in window";
	button.setAttribute("data-tooltip", detached ? "Bring this window’s linked application tab to the front." : "Open a resizable window that stays open when you click elsewhere.");
	button.disabled = false;
	const context = document.getElementById("source-context");
	if (context) context.textContent = bound ? `Linked to ${new URL(tabUrl).hostname} · stays on this application tab` : "Open in a window to keep this form beside the application.";
	button.addEventListener("click", async () => {
		button.disabled = true;
		try {
			await beforeOpen();
			const result = await chromeApi.runtime.sendMessage(detached
				? { type: "autofill-show-source" }
				: { type: "autofill-open-window", tabId, tabUrl });
			if (!result?.ok) throw new Error(result?.error || "The application window could not be opened.");
			if (mode === "popup") view.close();
			else if (mode === "sidepanel" && chromeApi.sidePanel?.close) await chromeApi.sidePanel.close({ tabId }).catch(() => {});
		} catch (error) {
			const message = document.getElementById("message");
			message.textContent = error.message; message.className = "error";
		} finally { button.disabled = false; }
	});
	if (!bound) return;
	// Each URL owns a separate saved draft. Reload before a new step can use the
	// old page's store, review, in-flight response or PDF selections.
	chromeApi.tabs.onUpdated.addListener((id, change, tab) => {
		if (id === tabId && ((change.url && change.url !== tabUrl) || (change.status === "complete" && tab.url !== tabUrl))) view.location.reload();
	});
	chromeApi.tabs.onRemoved.addListener((id) => {
		if (id !== tabId) return;
		document.getElementById("workspace").disabled = true;
		button.disabled = true;
		if (context) context.textContent = "The linked application tab is closed. Open the extension on another application to continue.";
	});
}
