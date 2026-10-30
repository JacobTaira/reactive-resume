import assert from "node:assert/strict";
import test from "node:test";
import { mountAutofillPopup } from "../src/autofill-popup.js";

// Exercise the real popup controller across destroyed/recreated documents. Only
// Chrome messaging, the DOM and the IndexedDB adapter are replaced here.
class Element {
	constructor(tagName = "DIV") {
		Object.assign(this, { tagName, children: [], listeners: {}, _value: "", textContent: "", className: "", files: [], hidden: false, disabled: false, checked: false, open: false });
	}
	get value() { return this._value; }
	set value(value) { this._value = value; if (this.type === "file" && !value) this.files = []; }
	append(...children) { this.children.push(...children); }
	replaceChildren(...children) { this.children = children; }
	addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
	querySelectorAll(selector) {
		return this.children.flatMap((child) => [
			...(child.tagName === "INPUT" && child.type === "checkbox" && (!selector.includes(":checked") || child.checked) ? [child] : []),
			...child.querySelectorAll(selector),
		]);
	}
	async emit(type) { for (const listener of this.listeners[type] || []) await listener({ currentTarget: this, preventDefault() {} }); }
}
const pdf = new File(["%PDF-1.7\nfictional manual resume"], "Example-Engineer.pdf", { type: "application/pdf" });
function fixture() {
	const records = new Map();
	const calls = [];
	const job = { id: "app-1", company: "Example", role: "Engineer", resumeId: "resume-1" };
	const state = { configured: false, selection: null, previewToken: null, draftContext: { sessionId: "session-1", tabId: 7, tabUrl: "https://careers.example.test/apply/123" } };
	let writeError = false;
	let beforePreview = async () => {};
	let beforeFill = async () => {};
	let fillError = null;
	let previewCount = 0;
	const openDraftStore = async (context) => {
		const key = JSON.stringify(context);
		return {
			read: async () => records.get(key) || null,
			write: (draft) => {
				if (writeError) return Promise.reject(new Error("Draft storage is full."));
				// File contents are immutable. Keep the File itself while cloning metadata;
				// Node's structuredClone does not retain File.name like browser IndexedDB.
				records.set(key, { ...structuredClone({ ...draft, file: null }), file: draft.file });
				return Promise.resolve();
			},
			clear: async () => { records.delete(key); },
		};
	};
	const chromeApi = { runtime: { sendMessage: async (message) => {
		calls.push(message);
		let data;
		if (message.type === "autofill-state") data = structuredClone(state);
		else if (message.type === "autofill-list") data = { items: [job], nextOffset: 100 };
		else if (message.type === "autofill-preview") {
			await beforePreview();
			state.previewToken = `preview-${++previewCount}`;
			data = { token: state.previewToken, tabUrl: state.draftContext.tabUrl, application: message.applicationId ? job : { company: message.company, role: message.role },
				fileName: message.manualResume?.fileName || "Linked-resume.pdf", message: "Review these fields.", fields: [
					{ id: "0:email", fieldId: "email", label: "Email", status: "matched", value: "example@example.test" },
					{ id: "0:phone", fieldId: "phone", label: "Phone", status: "matched", value: "555-0100" },
				] };
		} else if (message.type === "autofill-fill") {
			await beforeFill();
			if (fillError) {
				const error = fillError;
				fillError = null;
				return { ok: false, error };
			}
			state.previewToken = null;
			data = { reports: [{ filled: message.fieldIds.map((id) => ({ id })), failed: [] }], message: "Review on the employer page." };
		} else if (message.type === "autofill-clear-draft") { state.selection = null; state.previewToken = null; data = {}; }
		else throw new Error(`Unexpected message ${message.type}`);
		return { ok: true, data };
	} } };
	async function open() {
		const ids = ["message", "draft-status", "pdf-status", "workspace", "review", "selection", "page", "fields", "company", "role", "pdf", "application", "job", "manual", "load", "more", "capture", "preview", "fill", "clear"];
		const elements = Object.fromEntries(ids.map((id) => [id, new Element(["load", "more", "capture", "preview", "fill", "clear"].includes(id) ? "BUTTON" : "DIV")]));
		elements.pdf.type = "file"; elements.review.hidden = true; elements.workspace.disabled = true;
		const document = { getElementById: (id) => elements[id], createElement: (tag) => new Element(tag.toUpperCase()),
			defaultView: { DataTransfer: class { constructor() { this.files = []; this.items = { add: (file) => this.files.push(file) }; } } } };
		await mountAutofillPopup({ document, chromeApi, openDraftStore });
		return { ...elements, type: async (id, value) => { elements[id].value = value; await elements[id].emit("input"); },
			selectPdf: async (file = pdf) => { elements.pdf.files = [file]; await elements.pdf.emit("change"); } };
	}
	return { open, state, calls, job, records, failWrites: () => { writeError = true; }, delayPreview: (callback) => { beforePreview = callback; },
		delayFill: (callback) => { beforeFill = callback; }, rejectNextFill: (message) => { fillError = message; } };
}

test("typing saves on input without blur and restores the latest company and role after popup recreation", async () => {
	const subject = fixture();
	const first = await subject.open();
	await first.type("company", "E"); await first.type("company", "Example Robotics");
	await first.type("role", "Autonomy Engineer Intern");
	const reopened = await subject.open();
	assert.equal(reopened.company.value, "Example Robotics");
	assert.equal(reopened.role.value, "Autonomy Engineer Intern");
	assert.equal(reopened.workspace.disabled, false);
	assert.match(reopened["draft-status"].textContent, /restored/i);
});

test("manual PDF selection survives closing before preview and supplies the same bytes after reopening", async () => {
	const subject = fixture();
	const first = await subject.open();
	await first.type("company", "Example"); await first.selectPdf();
	const reopened = await subject.open();
	assert.equal(reopened.pdf.files[0].name, pdf.name);
	assert.match(reopened["pdf-status"].textContent, /Example-Engineer.pdf/);
	await reopened.preview.emit("click");
	const message = subject.calls.find((item) => item.type === "autofill-preview");
	assert.equal(message.company, "Example");
	assert.equal(message.manualResume.fileName, pdf.name);
	assert.equal(atob(message.manualResume.base64), await pdf.text());
});

test("loaded jobs, pagination and a selection made before preview are retained", async () => {
	const subject = fixture();
	const first = await subject.open();
	await first.load.emit("click"); first.application.value = subject.job.id;
	await first.application.emit("change");
	const reopened = await subject.open();
	assert.equal(reopened.application.value, subject.job.id);
	assert.equal(reopened.more.hidden, false);
	assert.match(reopened.job.textContent, /Example — Engineer/);
	assert.equal(reopened.manual.open, false);
	assert.equal(subject.calls.filter((item) => item.type === "autofill-list").length, 1);
});

test("review and unchecked fields survive popup recreation and filling uses the retained exact PDF", async () => {
	const subject = fixture();
	const first = await subject.open(); await first.selectPdf(); await first.preview.emit("click");
	const phone = first.fields.querySelectorAll("input[type=checkbox]")[1];
	phone.checked = false; await phone.emit("change");
	const reopened = await subject.open();
	assert.equal(reopened.review.hidden, false);
	assert.deepEqual(reopened.fields.querySelectorAll("input[type=checkbox]").map((field) => field.checked), [true, false]);
	await reopened.fill.emit("click");
	const message = subject.calls.find((item) => item.type === "autofill-fill");
	assert.deepEqual(message.fieldIds, ["0:email"]);
	assert.equal(atob(message.manualResume.base64), await pdf.text());
	const afterFill = await subject.open();
	assert.equal(afterFill.review.hidden, true);
	assert.match(afterFill.message.textContent, /1 fields filled/);
	assert.match(afterFill["pdf-status"].textContent, /Example-Engineer.pdf/);
});

test("expired or consumed previews are hidden without losing manual draft data", async () => {
	const subject = fixture();
	const first = await subject.open(); await first.type("role", "Engineer"); await first.selectPdf(); await first.preview.emit("click");
	subject.state.previewToken = null;
	const reopened = await subject.open();
	assert.equal(reopened.review.hidden, true);
	assert.equal(reopened.role.value, "Engineer");
	assert.match(reopened["pdf-status"].textContent, /Example-Engineer.pdf/);
	assert.match(reopened.message.textContent, /Preview the current form again/);
});

test("editing application details invalidates the reviewed fields immediately and persists that change", async () => {
	const subject = fixture();
	const first = await subject.open(); await first.selectPdf(); await first.preview.emit("click");
	await first.type("company", "Corrected company");
	const reopened = await subject.open();
	assert.equal(reopened.review.hidden, true);
	assert.equal(reopened.company.value, "Corrected company");
});

test("drafts never move to another tab, URL or browser session", async () => {
	const subject = fixture();
	const first = await subject.open(); await first.type("company", "Only this tab"); await first.selectPdf();
	const original = structuredClone(subject.state.draftContext);
	for (const change of [{ tabId: 8 }, { tabUrl: "https://careers.example.test/apply/456" }, { sessionId: "session-2" }]) {
		subject.state.draftContext = { ...original, ...change };
		const other = await subject.open();
		assert.equal(other.company.value, "");
		assert.equal(other["pdf-status"].textContent, "No manual PDF selected.");
	}
	subject.state.draftContext = original;
	assert.equal((await subject.open()).company.value, "Only this tab");
});

test("clearing a draft drops the file, text, selected job and review instead of reviving the worker selection", async () => {
	const subject = fixture();
	const first = await subject.open(); await first.load.emit("click");
	first.application.value = subject.job.id; await first.application.emit("change");
	subject.state.selection = subject.job;
	await first.type("company", "Example"); await first.selectPdf(); await first.preview.emit("click");
	await first.clear.emit("click");
	const reopened = await subject.open();
	assert.equal(reopened.company.value, ""); assert.equal(reopened.application.value, "");
	assert.equal(reopened.review.hidden, true);
	assert.equal(reopened["pdf-status"].textContent, "No manual PDF selected.");
});

test("a failed draft write is visible instead of falsely claiming the data was saved", async () => {
	const subject = fixture(); const first = await subject.open(); subject.failWrites();
	await first.type("company", "Keep this edit");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(first.company.value, "Keep this edit");
	assert.match(first["draft-status"].textContent, /could not be saved/);
	assert.match(first.message.textContent, /storage is full/);
});

test("an invalid replacement does not discard the already retained PDF", async () => {
	const subject = fixture(); const first = await subject.open(); await first.selectPdf();
	await first.selectPdf(new File(["text"], "not-a-pdf.txt"));
	assert.match(first.message.textContent, /Choose a PDF/);
	assert.match((await subject.open())["pdf-status"].textContent, /Example-Engineer.pdf/);
});

test("an in-flight preview cannot revive fields after the user edits the draft", async () => {
	const subject = fixture(); const first = await subject.open(); await first.selectPdf();
	let release;
	subject.delayPreview(() => new Promise((resolve) => { release = resolve; }));
	const pending = first.preview.emit("click");
	while (!release) await new Promise((resolve) => setImmediate(resolve));
	await first.type("company", "Changed during preview"); release(); await pending;
	assert.equal(first.review.hidden, true);
	assert.match(first.message.textContent, /details changed/);
	assert.equal((await subject.open()).company.value, "Changed during preview");
});

test("a rejected fill clears the saved review while retaining the job, details and PDF for a fresh preview", async () => {
	const subject = fixture();
	const first = await subject.open(); await first.load.emit("click");
	first.application.value = subject.job.id; await first.application.emit("change");
	await first.type("company", "Example"); await first.type("role", "Engineer");
	await first.selectPdf(); await first.preview.emit("click");
	const error = "Your approved profile, answers or connection changed. Preview again before filling.";
	subject.rejectNextFill(error);
	await first.fill.emit("click");
	assert.equal(first.review.hidden, true);
	assert.equal(first.fill.disabled, true);
	assert.equal(first.message.textContent, error);
	const reopened = await subject.open();
	assert.equal(reopened.review.hidden, true);
	assert.equal(reopened.fill.disabled, true);
	assert.equal(reopened.message.textContent, error);
	assert.equal(reopened.message.className, "error");
	assert.equal(reopened.application.value, subject.job.id);
	assert.equal(reopened.company.value, "Example");
	assert.equal(reopened.role.value, "Engineer");
	assert.equal(reopened.pdf.files[0].name, pdf.name);
	await reopened.preview.emit("click");
	assert.equal(reopened.review.hidden, false);
	assert.equal(reopened.fill.disabled, false);
	await reopened.fill.emit("click");
	assert.match(reopened.message.textContent, /2 fields filled/);
	const fills = subject.calls.filter((message) => message.type === "autofill-fill");
	assert.equal(fills.length, 2);
	assert.notEqual(fills[0].token, fills[1].token);
	assert.equal(atob(fills[1].manualResume.base64), await pdf.text());
});

test("an older rejected fill cannot clear or replace a newer review", async () => {
	const subject = fixture(); const first = await subject.open();
	await first.selectPdf(); await first.preview.emit("click");
	let release;
	subject.delayFill(() => new Promise((resolve) => { release = resolve; }));
	subject.rejectNextFill("The older preview was rejected.");
	const pending = first.fill.emit("click");
	while (!release) await new Promise((resolve) => setImmediate(resolve));
	await first.preview.emit("click");
	const newerToken = subject.state.previewToken;
	release(); await pending;
	assert.equal(first.review.hidden, false);
	assert.equal(first.fill.disabled, false);
	assert.equal(first.message.textContent, "Review these fields.");
	const reopened = await subject.open();
	assert.equal(subject.state.previewToken, newerToken);
	assert.equal(reopened.review.hidden, false);
	assert.equal(reopened.fill.disabled, false);
	assert.equal(reopened.message.textContent, "Review these fields.");
});
