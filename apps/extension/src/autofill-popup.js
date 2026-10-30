/* global chrome */
import { openAutofillDraftStore } from "./autofill-drafts.js";

export async function mountAutofillPopup({ document, chromeApi, openDraftStore = openAutofillDraftStore }) {
	const byId = (id) => document.getElementById(id);
	let preview = null;
	let selectedFile = null;
	let nextOffset = null;
	let jobs = new Map();
	let draftStore = null;
	let initialized = false;
	let revision = 0;
	let saveVersion = 0;
	byId("fill").disabled = true;
	const send = async (message) => {
		const result = await chromeApi.runtime.sendMessage(message);
		if (!result?.ok) throw new Error(result?.error || "The extension worker did not respond.");
		return result.data;
	};
	const report = (text, error = false) => { byId("message").textContent = text; byId("message").className = error ? "error" : ""; };
	const invalidate = () => { revision++; preview = null; byId("review").hidden = true; byId("fill").disabled = true; };
	const safely = (action) => async (event) => {
		event?.preventDefault();
		const button = event?.currentTarget;
		if (button?.tagName === "BUTTON") button.disabled = true;
		try { await action(); } catch (error) { report(error.message, true); }
		finally {
			if (button?.tagName === "BUTTON") button.disabled = button === byId("fill") && !preview?.fields.some((field) => field.status === "matched");
		}
	};
	const append = (parent, tag, text, className = "") => { const element = document.createElement(tag); element.textContent = text; element.className = className; parent.append(element); return element; };
	const option = (text, value) => { const element = document.createElement("option"); element.textContent = text; element.value = value; return element; };
	const selectedFields = () => [...byId("fields").querySelectorAll("input[type=checkbox]:checked")].map((field) => field.value);
	function saveDraft() {
		if (!initialized) return Promise.resolve();
		const version = ++saveVersion;
		byId("draft-status").textContent = "Saving this tab’s draft…";
		// The write starts in the input handler, including File cloning. Never depend
		// on popup blur/unload or an asynchronous file read to retain the selection.
		return draftStore.write({
			company: byId("company").value, role: byId("role").value,
			applicationId: byId("application").value, jobs: [...jobs.values()], nextOffset,
			manualOpen: byId("manual").open, file: selectedFile, preview,
			selectedFields: preview ? selectedFields() : [],
			message: byId("message").textContent, messageError: byId("message").className === "error",
		}).then(() => {
			if (version === saveVersion) byId("draft-status").textContent = "Draft saved for this application tab. You can close and reopen this popup.";
		}, (error) => {
			if (version === saveVersion) byId("draft-status").textContent = "Draft could not be saved. Keep this popup open and try again.";
			throw error;
		});
	}
	const saveInput = () => { void saveDraft().catch((error) => report(error.message, true)); };
	function showJob() {
		const job = jobs.get(byId("application").value);
		byId("job").textContent = job ? `${job.company} — ${job.role} · saved ID ${job.id}` : "Manual mode: choose a PDF and confirm the company and role.";
	}
	function showFile() {
		byId("pdf-status").textContent = selectedFile ? `Selected PDF: ${selectedFile.name}` : "No manual PDF selected.";
		if (selectedFile && !byId("pdf").files.length) {
			const transfer = new document.defaultView.DataTransfer();
			transfer.items.add(selectedFile);
			byId("pdf").files = transfer.files;
		}
	}
	function showJobs(applicationId = "") {
		byId("application").replaceChildren(option("Choose a PDF manually", ""));
		for (const job of jobs.values()) byId("application").append(option(`${job.company} — ${job.role}`, job.id));
		byId("application").value = jobs.has(applicationId) ? applicationId : "";
		byId("more").hidden = nextOffset === null;
		showJob();
	}
	function showPreview(value, checked = value.fields.filter((field) => field.status === "matched").map((field) => field.id)) {
		preview = value;
		const selection = new Set(checked);
		byId("selection").textContent = `${preview.application.company || "Manual application"}${preview.application.role ? ` — ${preview.application.role}` : ""}\nPDF: ${preview.fileName}`;
		byId("page").textContent = preview.tabUrl;
		byId("fields").replaceChildren();
		for (const field of preview.fields) {
			const card = append(byId("fields"), "div", "", "field");
			const label = append(card, "label", "");
			if (field.status === "matched") {
				const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.value = field.id; checkbox.checked = selection.has(field.id);
				checkbox.addEventListener("change", saveInput);
				label.append(checkbox);
			}
			append(label, "span", `${field.label || field.type} · ${field.status}`);
			append(card, "p", field.status === "matched" ? String(field.value ?? "") : field.reason || "Review this field on the employer’s page.");
			append(card, "p", `Field ID: ${field.fieldId}`, "muted field-id");
		}
		byId("review").hidden = false;
		byId("fill").disabled = !preview.fields.some((field) => field.status === "matched");
	}
	async function loadJobs(offset = 0) {
		const result = await send({ type: "autofill-list", offset });
		const selection = byId("application").value;
		if (!offset) { jobs = new Map(); invalidate(); }
		for (const job of result.items) jobs.set(job.id, job);
		nextOffset = result.nextOffset;
		showJobs(selection);
		report(`${jobs.size} prepared jobs loaded. Select the intended application and preview its form.`);
		await saveDraft();
	}
	async function manualPdf() {
		const file = selectedFile;
		if (!file) return null;
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
		selectedFile = null;
		showFile(); showJob();
		byId("manual").open = !jobs.has(byId("application").value);
		saveInput();
	});
	for (const id of ["company", "role"]) byId(id).addEventListener("input", () => { invalidate(); saveInput(); });
	byId("pdf").addEventListener("change", () => {
		const file = byId("pdf").files[0];
		if (!file) return;
		if (file.size > 10 * 1024 * 1024 || !/\.pdf$/i.test(file.name)) {
			byId("pdf").value = "";
			showFile();
			report("Choose a PDF no larger than 10 MB.", true);
			return;
		}
		selectedFile = file;
		invalidate(); showFile(); saveInput();
	});
	byId("manual").addEventListener("toggle", saveInput);
	byId("capture").addEventListener("click", safely(async () => { const result = await send({ type: "autofill-capture" }); report(result.message); }));
	byId("preview").addEventListener("click", safely(async () => {
		invalidate();
		const currentRevision = revision;
		report("Loading the selected resume and reading this form…");
		await saveDraft();
		const message = { type: "autofill-preview", applicationId: byId("application").value, company: byId("company").value, role: byId("role").value, manualResume: await manualPdf() };
		if (currentRevision !== revision) throw new Error("The application details changed. Preview the current selection again.");
		const result = await send(message);
		if (currentRevision !== revision) throw new Error("The application details changed. Preview the current selection again.");
		showPreview(result);
		report(preview.message);
		await saveDraft();
	}));
	byId("fill").addEventListener("click", safely(async () => {
		if (!preview) throw new Error("Preview the current form first.");
		const currentRevision = revision;
		const message = { type: "autofill-fill", token: preview.token, fieldIds: selectedFields(), manualResume: await manualPdf() };
		if (currentRevision !== revision) throw new Error("The application details changed. Preview the current selection again.");
		let result;
		try { result = await send(message); }
		catch (error) {
			// A rejected review must not remain available for repeated filling or be
			// revived from the draft. Preserve a newer review created while waiting.
			if (currentRevision !== revision || preview?.token !== message.token) return;
			invalidate();
			report(error.message, true);
			await saveDraft();
			return;
		}
		if (currentRevision !== revision || preview?.token !== message.token) return;
		const filled = result.reports.flatMap((entry) => entry?.filled || []);
		const failed = result.reports.flatMap((entry) => [...new Map([...(entry?.failed || []), ...(entry?.unsupported || [])]
			.map((field) => [field.id || field.label, field])).values()]);
		invalidate();
		report(`${filled.length} fields filled or files selected. ${failed.length} need attention.\n${failed.map((entry) => `${entry.label || entry.id}: ${entry.reason || "Review manually"}`).join("\n")}\n${result.message}`);
		await saveDraft();
	}));
	byId("clear").addEventListener("click", safely(async () => {
		invalidate(); saveVersion++;
		byId("company").value = ""; byId("role").value = ""; byId("pdf").value = "";
		selectedFile = null; showFile(); showJobs(); byId("manual").open = true;
		await Promise.all([draftStore.clear(), send({ type: "autofill-clear-draft" })]);
		report("This application’s draft and manual PDF selection were cleared.");
		byId("draft-status").textContent = "New choices will be saved for this application tab.";
	}));
	try {
		const state = await send({ type: "autofill-state" });
		draftStore = await openDraftStore(state.draftContext);
		const draft = await draftStore.read();
		if (draft) {
			jobs = new Map(draft.jobs.map((job) => [job.id, job])); nextOffset = draft.nextOffset;
			byId("company").value = draft.company; byId("role").value = draft.role;
			selectedFile = draft.file;
			showJobs(draft.applicationId); showFile();
			byId("manual").open = draft.manualOpen;
			if (draft.preview?.token === state.previewToken && state.previewToken) showPreview(draft.preview, draft.selectedFields);
			report(draft.preview && !preview ? "Draft restored. Preview the current form again before filling." : draft.message, draft.messageError);
			byId("draft-status").textContent = "Draft restored for this application tab.";
		} else {
			if (state.selection?.id) jobs.set(state.selection.id, state.selection);
			showJobs(state.selection?.id); showFile();
			byId("manual").open = !state.selection?.id;
			byId("draft-status").textContent = "Choices and PDF selections are saved for this tab while Chrome stays open.";
			if (!state.configured) report("Open Autofill settings to approve your profile. Add a normal MCP key for saved resumes, or choose a PDF manually.");
		}
		initialized = true;
		byId("workspace").disabled = false;
	} catch (error) { report(error.message, true); byId("draft-status").textContent = "The application draft could not be opened. Reopen this popup to try again."; }
}

if (globalThis.document && globalThis.chrome) void mountAutofillPopup({ document, chromeApi: chrome });
