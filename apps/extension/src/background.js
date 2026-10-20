/* global chrome */
import { addCapture, captureFailed, captureSucceeded, dueCaptures, normalizedBaseUrl } from "./outbox.js";
import "./extractor.js";

let serial = Promise.resolve();
let syncing = false;
const initialize = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
const mutate = (operation) => {
	const run = serial.catch(() => {}).then(async () => { await initialize; return operation(); });
	serial = run;
	return run;
};
const read = async () => { await initialize; return chrome.storage.local.get({ config: null, outbox: [], bulk: null }); };
const extensionPage = (sender) => {
	if (sender.id !== chrome.runtime.id || typeof sender.url !== "string") return false;
	try {
		const url = new URL(sender.url);
		// Options open in a normal browser tab. Authenticate the extension and page,
		// rather than rejecting every sender that has a tab.
		return url.protocol === "chrome-extension:" && url.host === chrome.runtime.id && url.pathname === "/options.html";
	} catch {
		return false;
	}
};
const jobrightPage = (sender) => {
	try { return new URL(sender.tab?.url || sender.url).origin === "https://jobright.ai"; } catch { return false; }
};
async function badge(text, color = "#3657b8") {
	await chrome.action.setBadgeBackgroundColor({ color });
	await chrome.action.setBadgeText({ text });
}
async function request(path, body) {
	const { config } = await read();
	if (!config?.baseUrl || !config?.apiKey) throw new Error("Open extension settings and configure the installation URL and capture key.");
	const baseUrl = normalizedBaseUrl(config.baseUrl);
	const response = await fetch(`${baseUrl}/api/openapi/applications/capture${path}`, {
		method: body ? "POST" : "GET", credentials: "omit", redirect: "error",
		headers: { "x-api-key": config.apiKey, ...(body ? { "Content-Type": "application/json" } : {}) },
		...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000),
	});
	let data;
	try { data = await response.json(); } catch { throw new Error(`The installation returned an unreadable response (${response.status}).`); }
	if (!response.ok) {
		const error = new Error(data.message || data.error?.message || `Server error ${response.status}`);
		error.permanent = response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status);
		throw error;
	}
	return data;
}

function enqueue(payload) {
	return mutate(async () => {
		const state = await read();
		const result = addCapture(state.outbox, payload, crypto.randomUUID());
		await chrome.storage.local.set({ outbox: result.items });
		await badge("…");
		return { id: result.item.id, status: result.item.status, existing: result.existing };
	});
}
function settle(id, update) {
	return mutate(async () => {
		const { outbox } = await read();
		await chrome.storage.local.set({ outbox: outbox.map((item) => item.id === id ? update(item) : item) });
	});
}
async function flush() {
	if (syncing) return;
	syncing = true;
	try {
		const { outbox, config } = await read();
		if (!config?.apiKey) { if (outbox.some((item) => item.status !== "saved")) await badge("SET", "#b65a10"); return; }
		const due = dueCaptures(outbox);
		if (due.length) {
			try {
				const response = await request("/batch", { items: due.map((item) => item.body) });
				if (!Array.isArray(response.results)) throw new Error("The server did not return capture results. Your local copies are retained.");
				for (const [index, item] of due.entries()) {
					const entry = response.results.find((value) => value.index === index);
					try {
						if (entry?.result) await settle(item.id, (current) => JSON.stringify(current.body) === JSON.stringify(item.body)
							? captureSucceeded(current, entry.result)
							: { ...current, status: "waiting", nextAttemptAt: 0, error: "An improved capture is waiting to sync." });
						else await settle(item.id, (current) => captureFailed(current, entry?.error?.message || "The server did not confirm this item.", Boolean(entry?.error && !["TOO_MANY_REQUESTS", "INTERNAL_SERVER_ERROR"].includes(entry.error.code))));
					} catch (error) { await settle(item.id, (current) => captureFailed(current, error.message)); }
				}
			} catch (error) {
				for (const item of due) await settle(item.id, (current) => captureFailed(current, error.message, Boolean(error.permanent)));
			}
		}
		const latest = await read();
		const failed = latest.outbox.filter((item) => item.status === "failed").length;
		const attention = latest.outbox.filter((item) => item.status === "attention").length;
		const pending = latest.outbox.filter((item) => item.status === "waiting" || item.status === "sending").length;
		if (failed) await badge("!", "#b42318");
		else if (pending) await badge(String(pending), "#b65a10");
		else if (attention) await badge("CHECK", "#b65a10");
		else await badge(due.length ? "✓" : "");
	} finally { syncing = false; }
}
async function captureTab(tab) {
	try {
		if (!tab?.id || !/^https?:\/\//.test(tab.url || "")) throw new Error("Open an ordinary job webpage before capturing.");
		await badge("…");
		await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["src/extractor.js"] });
		const isJobright = new URL(tab.url).hostname.replace(/^www\./, "") === "jobright.ai";
		let payload;
		for (let attempt = 0; attempt < 8; attempt++) {
			const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => globalThis.ReactiveCaptureExtract.extractDocument(document) });
			payload = results[0]?.result;
			if (!payload || !isJobright || (!payload.descriptionIncomplete && !payload.companyFallback && !payload.roleFallback
				&& globalThis.ReactiveCaptureExtract.hasJobDescriptionText(payload.description))) break;
			if (attempt < 7) await new Promise((resolve) => setTimeout(resolve, 750));
		}
		if (!payload) throw new Error("The page could not be read. Open extension settings for details.");
		if (isJobright && (new URL(payload.url).origin !== new URL(tab.url).origin
			|| new URL(payload.url).pathname !== new URL(tab.url).pathname)) {
			throw new Error("The posting changed during capture. Open the intended job and capture it again.");
		}
		await enqueue(payload);
		await chrome.storage.local.set({ lastError: "" });
		void flush();
	} catch (error) {
		await chrome.storage.local.set({ lastError: error.message });
		await badge("!", "#b42318");
		await chrome.runtime.openOptionsPage();
	}
}
chrome.action.onClicked.addListener((tab) => { void captureTab(tab); });
chrome.commands.onCommand.addListener((command) => {
	if (command === "capture-job") void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => captureTab(tab));
});
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === "capture-sync") void flush(); });
chrome.runtime.onInstalled.addListener(() => { void chrome.alarms.create("capture-sync", { periodInMinutes: 0.5 }); });
chrome.runtime.onStartup.addListener(() => { void chrome.alarms.create("capture-sync", { periodInMinutes: 0.5 }); void flush(); });

chrome.runtime.onMessage.addListener((message, sender, respond) => {
	const run = async () => {
		if (message.type === "capture" && jobrightPage(sender)) {
			const payload = message.payload;
			if (new URL(payload.url).origin !== "https://jobright.ai") throw new Error("Only Jobright captures are accepted from this content script.");
			const result = await enqueue(payload); void flush(); return result;
		}
		if (message.type === "bulk-state" && jobrightPage(sender)) {
			return mutate(async () => {
				const bulk = message.bulk;
				if (!Array.isArray(bulk.items) || bulk.items.length > 5000) throw new Error("Bulk collection limit reached (5,000 jobs). Progress is retained.");
				const previous = (await read()).bulk;
				if (previous && previous.id !== bulk.id && !message.resume) throw new Error("Another liked-list capture has started. This older run is paused.");
				const next = previous?.id === bulk.id && previous.canceled && !message.resume ? { ...bulk, canceled: true, phase: "paused" } : bulk;
				await chrome.storage.local.set({ bulk: next }); return { ok: true };
			});
		}
		if (message.type === "bulk-get" && jobrightPage(sender)) return { bulk: (await read()).bulk };
		if (!extensionPage(sender)) throw new Error("This action is available only in extension settings.");
		if (message.type === "state") {
			const state = await read();
			const { lastError = "" } = await chrome.storage.local.get("lastError");
			return { outbox: state.outbox, bulk: state.bulk, lastError, baseUrl: state.config?.baseUrl || "", configured: Boolean(state.config?.apiKey) };
		}
		if (message.type === "configure") {
			const baseUrl = normalizedBaseUrl(message.baseUrl);
			if (!(await chrome.permissions.contains({ origins: [`${baseUrl}/*`] }))) throw new Error("Access to the installation has not been granted.");
			const { config } = await read();
			const apiKey = String(message.apiKey || (config?.baseUrl === baseUrl ? config.apiKey : "")).trim();
			if (!apiKey) throw new Error("Enter a capture-only API key.");
			await chrome.storage.local.set({ config: { baseUrl, apiKey }, lastError: "" });
			return { ok: true };
		}
		if (message.type === "test") return request("/status");
		if (message.type === "sync") { void flush(); return { ok: true }; }
		if (message.type === "retry") {
			await mutate(async () => {
				const { outbox } = await read();
				await chrome.storage.local.set({ outbox: outbox.map((item) => ["waiting", "sending", "failed"].includes(item.status) && (!message.id || item.id === message.id) ? { ...item, status: "waiting", attempts: 0, nextAttemptAt: 0 } : item) });
			});
			void flush(); return { ok: true };
		}
		if (message.type === "remove") {
			await mutate(async () => {
				const { outbox } = await read(); await chrome.storage.local.set({ outbox: outbox.filter((item) => item.id !== message.id) });
			});
			return { ok: true };
		}
		if (message.type === "bulk-cancel") {
			await mutate(async () => { const { bulk } = await read(); if (bulk) await chrome.storage.local.set({ bulk: { ...bulk, canceled: true, phase: "paused" } }); });
			return { ok: true };
		}
		throw new Error("Unknown capture command.");
	};
	run().then((data) => respond({ ok: true, data }), (error) => respond({ ok: false, error: error.message }));
	return true;
});
// Recreate the alarm if Chrome discarded it. Pending entries survive worker termination.
void chrome.alarms.get("capture-sync").then((alarm) => { if (!alarm) return chrome.alarms.create("capture-sync", { periodInMinutes: 0.5 }); });
void flush();
