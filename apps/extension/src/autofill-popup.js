/* global chrome */
const byId = (id) => document.getElementById(id);
let preview = null;
let nextOffset = null;
let jobs = new Map();
const send = async (message) => {
	const result = await chrome.runtime.sendMessage(message);
	if (!result?.ok) throw new Error(result?.error || "The extension worker did not respond.");
	return result.data;
};
const report = (text, error = false) => { byId("message").textContent = text; byId("message").className = error ? "error" : ""; };
const invalidate = () => { preview = null; byId("review").hidden = true; };
const safely = (action) => async (event) => {
	event?.preventDefault();
	const button = event?.currentTarget;
	if (button?.tagName === "BUTTON") button.disabled = true;
	try { await action(); } catch (error) { report(error.message, true); }
	finally { if (button?.tagName === "BUTTON") button.disabled = false; }
};
const append = (parent, tag, text, className = "") => { const element = document.createElement(tag); element.textContent = text; element.className = className; parent.append(element); return element; };
async function loadJobs(offset = 0) {
	const result = await send({ type: "autofill-list", offset });
	if (!offset) { jobs = new Map(); byId("application").replaceChildren(new Option("Choose a PDF manually", "")); invalidate(); }
	for (const job of result.items) {
		if (jobs.has(job.id)) continue;
		jobs.set(job.id, job);
		byId("application").append(new Option(`${job.company} — ${job.role}`, job.id));
	}
	nextOffset = result.nextOffset;
	byId("more").hidden = nextOffset === null;
	report(`${jobs.size} prepared jobs loaded. Select the intended application and preview its form.`);
}
async function manualPdf() {
	const file = byId("pdf").files[0];
	if (!file) return null;
	if (file.size > 10 * 1024 * 1024 || !/\.pdf$/i.test(file.name)) throw new Error("Choose a PDF no larger than 10 MB.");
	const bytes = new Uint8Array(await file.arrayBuffer());
	let binary = "";
	for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
	return { base64: btoa(binary), fileName: file.name, mimeType: "application/pdf" };
}
byId("load").addEventListener("click", safely(() => loadJobs()));
byId("more").addEventListener("click", safely(() => loadJobs(nextOffset)));
byId("application").addEventListener("change", () => {
	invalidate();
	byId("pdf").value = "";
	const job = jobs.get(byId("application").value);
	byId("job").textContent = job ? `${job.company} — ${job.role} · saved ID ${job.id}` : "Manual mode: choose a PDF and confirm the company and role.";
	byId("manual").open = !job;
});
for (const id of ["company", "role", "pdf"]) byId(id).addEventListener("change", invalidate);
byId("capture").addEventListener("click", safely(async () => { const result = await send({ type: "autofill-capture" }); report(result.message); }));
byId("preview").addEventListener("click", safely(async () => {
	invalidate();
	report("Loading the selected resume and reading this form…");
	preview = await send({ type: "autofill-preview", applicationId: byId("application").value, company: byId("company").value, role: byId("role").value, manualResume: await manualPdf() });
	byId("selection").textContent = `${preview.application.company || "Manual application"}${preview.application.role ? ` — ${preview.application.role}` : ""}\nPDF: ${preview.fileName}`;
	byId("page").textContent = preview.tabUrl;
	byId("fields").replaceChildren();
	for (const field of preview.fields) {
		const card = append(byId("fields"), "div", "", "field");
		const label = append(card, "label", "");
		if (field.status === "matched") {
			const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.value = field.id; checkbox.checked = true;
			label.append(checkbox);
		}
		append(label, "span", `${field.label || field.type} · ${field.status}`);
		append(card, "p", field.status === "matched" ? String(field.value ?? "") : field.reason || "Review this field on the employer’s page.");
		append(card, "p", `Field ID: ${field.fieldId}`, "muted field-id");
	}
	byId("review").hidden = false;
	byId("fill").disabled = !preview.fields.some((field) => field.status === "matched");
	report(preview.message);
}));
byId("fill").addEventListener("click", safely(async () => {
	if (!preview) throw new Error("Preview the current form first.");
	const fieldIds = [...byId("fields").querySelectorAll("input[type=checkbox]:checked")].map((field) => field.value);
	const result = await send({ type: "autofill-fill", token: preview.token, fieldIds, manualResume: await manualPdf() });
	const filled = result.reports.flatMap((entry) => entry?.filled || []);
	const failed = result.reports.flatMap((entry) => [...new Map([...(entry?.failed || []), ...(entry?.unsupported || [])]
		.map((field) => [field.id || field.label, field])).values()]);
	invalidate();
	report(`${filled.length} fields filled or files selected. ${failed.length} need attention.\n${failed.map((entry) => `${entry.label || entry.id}: ${entry.reason || "Review manually"}`).join("\n")}\n${result.message}`);
}));
void send({ type: "autofill-state" }).then((state) => {
	byId("manual").open = !state.configured;
	if (state.selection?.id) {
		jobs.set(state.selection.id, state.selection);
		byId("application").append(new Option(`${state.selection.company} — ${state.selection.role}`, state.selection.id, true, true));
		byId("job").textContent = `${state.selection.company} — ${state.selection.role} · retained for this exact tab and page`;
		byId("manual").open = false;
	}
	if (!state.configured) report("Open Autofill settings to approve your profile. Add a normal MCP key for saved resumes, or choose a PDF manually.");
}).catch((error) => report(error.message, true));
