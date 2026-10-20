/* global chrome */
import { normalizedBaseUrl } from "./outbox.js";

const byId = (id) => document.getElementById(id);
const send = async (message) => {
	const response = await chrome.runtime.sendMessage(message);
	if (!response?.ok) throw new Error(response?.error || "The extension worker did not respond.");
	return response.data;
};
const report = (text, error = false) => { byId("message").textContent = text; byId("message").className = error ? "error" : ""; };
const safely = (action) => async (event) => { event?.preventDefault(); try { await action(); } catch (error) { report(error.message, true); } };
const append = (parent, tag, text, className = "") => { const element = document.createElement(tag); element.textContent = text; element.className = className; parent.append(element); return element; };
async function render(initial = false) {
	const state = await send({ type: "state" });
	if (initial) byId("base-url").value = state.baseUrl || "http://localhost:3000";
	if (state.lastError && initial) report(state.lastError, true);
	const waiting = state.outbox.filter((item) => ["waiting", "sending"].includes(item.status)).length;
	const saved = state.outbox.filter((item) => ["saved", "attention"].includes(item.status)).length;
	const attention = state.outbox.filter((item) => item.status === "attention").length;
	const failed = state.outbox.filter((item) => item.status === "failed").length;
	byId("summary").textContent = `${saved} server-confirmed · ${attention} need details · ${waiting} waiting to sync · ${failed} failed. Recent completed history is limited to 100 items.`;
	byId("outbox").replaceChildren();
	for (const item of [...state.outbox].reverse()) {
		const card = append(byId("outbox"), "article", "", "item");
		append(card, "strong", `${item.body.company || "Company needs review"} — ${item.body.role || item.body.title || "Job posting"}`);
		append(card, "p", ["saved", "attention"].includes(item.status) ? `${item.result.result === "duplicate" ? "Already saved" : "Saved in Applications"} · ${item.result.state} · ID ${item.result.id}` : item.status === "failed" ? "Failed — your captured copy is retained" : "Waiting to sync — stored in this browser");
		const original = append(card, "a", "Open posting"); original.href = item.body.url; original.target = "_blank"; original.rel = "noreferrer";
		if (item.result?.appUrl) { const link = append(card, "a", " · Open application"); link.href = item.result.appUrl; link.target = "_blank"; link.rel = "noreferrer"; }
		if (item.result?.possibleDuplicateOf) append(card, "p", `Possible duplicate of application ${item.result.possibleDuplicateOf}. Both were kept for review.`);
		if (item.error) append(card, "p", item.error, "error");
		for (const warning of item.warnings || []) append(card, "p", warning, "muted");
		if (item.status === "attention") {
			append(card, "p", "Open this application in Applications → Queue and repair its details. Capturing a duplicate does not change the saved application. Your full captured description is retained below.", "error");
			if (item.body.description) {
				const copy = append(card, "button", "Copy captured description"); copy.type = "button";
				copy.addEventListener("click", safely(async () => { await navigator.clipboard.writeText(item.body.description); report("Description copied. Paste it into the existing application’s queue details."); }));
				const details = append(card, "details", ""); append(details, "summary", "Show captured description");
				const text = append(details, "textarea", ""); text.value = item.body.description; text.readOnly = true; text.rows = 8; text.setAttribute("aria-label", "Captured description for manual repair");
			}
		}
		if (["waiting", "sending", "failed"].includes(item.status)) {
			const retry = append(card, "button", "Retry"); retry.type = "button";
			retry.addEventListener("click", safely(async () => { await send({ type: "retry", id: item.id }); await render(); }));
		}
		const remove = append(card, "button", item.status === "saved" ? "Clear local history" : item.status === "attention" ? "Clear local repair copy" : "Discard local capture"); remove.type = "button";
		remove.addEventListener("click", safely(async () => {
			if (item.status !== "saved" && !confirm(item.status === "attention" ? "Clear the local repair copy? Make sure the captured description has been saved in the application first." : "Discard this unsynced job from this browser? It may not exist in Applications.")) return;
			await send({ type: "remove", id: item.id }); await render();
		}));
	}
	const bulk = state.bulk;
	byId("bulk").replaceChildren();
	if (bulk) {
		append(byId("bulk"), "p", `${bulk.phase} · ${bulk.items.length} distinct postings discovered · ${bulk.items.filter((item) => item.status === "captured").length} captured locally.`);
		if (bulk.warning) append(byId("bulk"), "p", bulk.warning, "error");
		for (const item of bulk.items.filter((entry) => entry.error)) append(byId("bulk"), "p", `${item.url}: ${item.error}`, "error");
	}
}
byId("settings").addEventListener("submit", safely(async () => {
	const baseUrl = normalizedBaseUrl(byId("base-url").value);
	const granted = await chrome.permissions.request({ origins: [`${baseUrl}/*`] });
	if (!granted) throw new Error("Installation access was not granted. Settings were not changed.");
	await send({ type: "configure", baseUrl, apiKey: byId("api-key").value });
	byId("api-key").value = ""; report("Settings saved. Test the connection, then capture a job."); await render();
}));
byId("test").addEventListener("click", safely(async () => {
	const result = await send({ type: "test" });
	if (!result.connected || !result.captureAllowed) throw new Error("The server did not confirm capture permission.");
	report("Connected. This capture key can save jobs to Applications.");
}));
byId("sync").addEventListener("click", safely(async () => { await send({ type: "sync" }); report("Sync requested. Server confirmations will appear below."); }));
byId("retry").addEventListener("click", safely(async () => { await send({ type: "retry" }); report("Pending and failed captures will be retried."); }));
byId("pause").addEventListener("click", safely(async () => { await send({ type: "bulk-cancel" }); report("Liked-list capture will pause after its current operation."); await render(); }));
chrome.storage.onChanged.addListener(() => { void render().catch((error) => report(error.message, true)); });
void render(true).catch((error) => report(error.message, true));
