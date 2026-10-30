import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

// Runs the real engine with a small DOM adapter. Browser tests separately cover
// native browser behavior; this adapter exercises mapping, preservation and writes.
const source = fs.readFileSync(new URL("../src/autofill-engine.js", import.meta.url), "utf8");
class FixtureEvent {
	constructor(type) { this.type = type; }
}
class FixtureTransfer {
	constructor() { this.files = []; this.items = { add: file => this.files.push(file) }; }
}
class FixtureElement {
	constructor(document, options = {}) {
		this.ownerDocument = document;
		this.tagName = options.tag || "INPUT";
		this.type = options.type || (this.tagName === "SELECT" ? "select-one" : "text");
		this.id = options.id || `field-${document.controls.length}`;
		this.name = options.name || "";
		this.labels = options.labelNode ? [options.labelNode] : options.label ? [{ innerText: options.label }] : [];
		this.attributes = options.attributes || {};
		this._value = options.value || "";
		this._checked = options.checked || false;
		this._files = [];
		this.options = options.options || [];
		this.disabled = options.disabled || false;
		this.readOnly = options.readOnly || false;
		this.hidden = options.hidden || false;
		this.isConnected = true;
		this.nodeType = 1;
		this.parentElement = options.parent || (options.heading ? { tagName: "FIELDSET", id: "", nodeType: 1, children: [],
			parentElement: document.documentElement, getAttribute: () => null, getRootNode: () => document,
			querySelector: () => ({ innerText: options.heading }) } : document.documentElement);
		this.parentElement.children.push(this);
		this.children = [];
		this.events = [];
		this.clicks = 0;
		this.form = document.form;
		this.accept = options.accept || "";
		this.fieldset = options.fieldset;
	}
	get value() { return this._value; }
	set value(value) { this._value = String(value); }
	get checked() { return this._checked; }
	set checked(value) {
		this._checked = Boolean(value);
		if (this.type === "radio" && value) {
			for (const element of this.ownerDocument.controls) {
				if (element !== this && element.type === "radio" && element.name === this.name) element._checked = false;
			}
		}
	}
	get files() { return this._files; }
	set files(value) { this._files = value; }
	get selectedOptions() { return this.options.filter(option => option.value === this.value); }
	getAttribute(name) { return this.attributes[name] ?? (name === "name" ? this.name : null); }
	getRootNode() { return this.ownerDocument; }
	getClientRects() { return [{}]; }
	closest(selector) { return selector === "fieldset" ? this.fieldset || null : null; }
	querySelector() { return null; }
	dispatchEvent(event) { this.events.push(event.type); return true; }
	click() {
		this.clicks++;
		if (this.type === "radio" || this.type === "checkbox") {
			this.checked = this.type === "radio" || !this.checked;
			for (const type of ["click", "input", "change"]) this.dispatchEvent(new FixtureEvent(type));
		}
	}
}
function environment(definitions) {
	const document = {
		URL: "https://employer.example.test/apply/one", controls: [], form: { id: "application" },
		defaultView: {
			getComputedStyle: () => ({ display: "block", visibility: "visible" }), Event: FixtureEvent,
			InputEvent: FixtureEvent, FocusEvent: FixtureEvent, KeyboardEvent: FixtureEvent,
			File, DataTransfer: FixtureTransfer, atob,
		},
		querySelectorAll(selector) {
			if (selector === "[id]") return this.controls;
			if (selector === '[role="option"]') return [];
			return this.controls;
		},
		getElementById(id) { return this.controls.find(element => element.id === id); },
	};
	document.documentElement = {
		tagName: "HTML", id: "", nodeType: 1, parentElement: null, children: [],
		getAttribute: () => null, getRootNode: () => document, querySelector: () => null,
	};
	for (const definition of definitions) document.controls.push(new FixtureElement(document, definition));
	const context = vm.createContext({ URL, Uint8Array, setTimeout });
	vm.runInContext(source, context);
	return { document, fields: document.controls, engine: context.ReactiveResumeAutofill };
}
const packet = {
	profile: { firstName: "Alex", lastName: "Example", email: "alex@example.test", country: "United States", state: "Texas", website: "https://example.test" },
	application: { id: "application-one", company: "Example Robotics", role: "Engineer" }, answers: [],
};

test("real engine maps approved identity fields and keeps field identities stable", async () => {
	const { document, fields, engine } = environment([
		{ label: "First name", attributes: { autocomplete: "given-name" } }, { label: "Last name" },
		{ label: "Email address", type: "email" }, { label: "Full name" }, { label: "Personal website", type: "url" },
	]);
	const first = engine.plan(document, packet);
	assert.equal(first.matched.length, 5);
	assert.equal(first.fingerprint, engine.plan(document, packet).fingerprint);
	assert.doesNotThrow(() => JSON.stringify(first));
	const result = await engine.fill(document, packet);
	assert.equal(result.filled.length, 5);
	assert.deepEqual(fields.map(field => field.value), ["Alex", "Example", "alex@example.test", "Alex Example", "https://example.test"]);
	assert.ok(fields.every(field => field.events.includes("input") && field.events.includes("change")));
	assert.ok(fields.every(field => field.clicks === 0));
});

test("existing edits survive and selection applies only the chosen preview field", async () => {
	const { document, fields, engine } = environment([{ label: "First name", value: "Keep my edit" }, { label: "Email address" }, { label: "Last name" }]);
	const preview = engine.plan(document, packet);
	assert.equal(preview.fields[0].status, "preserved");
	await engine.fill(document, packet, { fieldIds: [preview.fields[1].id], expectedUrl: preview.pageUrl, expectedFingerprint: preview.fingerprint });
	assert.deepEqual(fields.map(field => field.value), ["Keep my edit", "alex@example.test", ""]);
});

test("employer names, generic URLs, sensitive data and unknown screening answers are not inferred", async () => {
	const { document, fields, engine } = environment([
		{ label: "Current employer name", name: "employerName" }, { label: "URL", type: "url", attributes: { autocomplete: "url" } },
		{ label: "Gender" }, { label: "How many years of experience do you have?", type: "number" },
		{ label: "I agree to the terms", type: "checkbox" }, { label: "Password", type: "password" },
		{ label: "First name", type: "hidden" }, { label: "Email", disabled: true },
	]);
	assert.equal(engine.scan(document).length, 5);
	const result = await engine.fill(document, packet);
	assert.equal(result.filled.length, 0);
	assert.ok(fields.every(field => !field.value && !field.checked && !field.clicks));
});

test("approved answers require exact questions, honor job scope and reject conflicts", async () => {
	const { document, fields, engine } = environment([
		{ label: "Why this company?", tag: "TEXTAREA" }, { label: "Years of experience", type: "number" },
		{ label: "Will you require sponsorship?" }, { label: "A conflicting question" },
	]);
	const answers = [
		{ question: "Why this company?", answer: "Wrong job", applicationId: "different" },
		{ question: "Years of experience?", answer: "3", approved: false },
		{ question: "Will you require sponsorship?", answer: "Yes" },
		{ question: "Will you require sponsorship?", answer: "No", applicationId: "application-one" },
		{ question: "A conflicting question", answer: "One" }, { question: "A conflicting question", answer: "Two" },
	];
	const result = await engine.fill(document, { ...packet, answers });
	assert.deepEqual(fields.map(field => field.value), ["", "", "No", ""]);
	assert.equal(result.filled.length, 1);
	assert.match(result.unmatched.at(-1).reason, /Conflicting/);
});

test("select fields require a unique exact option and distinguish country from nationality", async () => {
	const { document, fields, engine } = environment([
		{ label: "State", tag: "SELECT", options: [{ label: "Select", value: "" }, { label: "Texas", value: "TX" }] },
		{ label: "Country", tag: "SELECT", options: [{ label: "Select", value: "" }, { label: "United States", value: "US" }] },
		{ label: "Nationality", tag: "SELECT", options: [{ label: "Select", value: "" }, { label: "United States", value: "US" }] },
	]);
	await engine.fill(document, packet);
	assert.deepEqual(fields.map(field => field.value), ["TX", "US", ""]);
	const duplicate = environment([{ label: "Country", tag: "SELECT", options: [{ label: "United States", value: "US" }, { label: "United States", value: "USA" }] }]);
	const preview = duplicate.engine.plan(duplicate.document, packet);
	assert.equal(preview.fields[0].status, "unsupported");
});

test("nonempty select placeholder values can be filled while real choices stay preserved", async () => {
	for (const value of ["-1", "0", "Select"]) {
		const { document, fields, engine } = environment([{ label: "Country", tag: "SELECT", value,
			options: [{ label: "-- Please select country --", value }, { label: "United States", value: "US" }] }]);
		assert.equal(engine.plan(document, packet).fields[0].status, "matched");
		await engine.fill(document, packet);
		assert.equal(fields[0].value, "US");
	}
	const chosen = environment([{ label: "Country", tag: "SELECT", value: "CA",
		options: [{ label: "Canada", value: "CA" }, { label: "United States", value: "US" }] }]);
	await chosen.engine.fill(chosen.document, packet);
	assert.equal(chosen.fields[0].value, "CA");
});

test("generic name with employer or school identity never becomes candidate name", async () => {
	const { document, fields, engine } = environment([
		{ label: "Name", name: "employerName", attributes: { autocomplete: "name" } },
		{ label: "Name", name: "schoolName", attributes: { autocomplete: "name" } },
	]);
	await engine.fill(document, packet);
	assert.deepEqual(fields.map(field => field.value), ["", ""]);
});

test("all candidate profile data stays out of references, emergency contacts and employer history", async () => {
	const { document, fields, engine } = environment([
		{ label: "Email", heading: "Reference", attributes: { autocomplete: "email" } },
		{ label: "Phone", name: "emergencyPhone", attributes: { autocomplete: "tel" } },
		{ label: "City", name: "employerCity", attributes: { autocomplete: "address-level2" } },
		{ label: "Address", heading: "Emergency contact", attributes: { autocomplete: "address-line1" } },
		{ label: "Website", heading: "School" },
	]);
	const completeProfile = { ...packet.profile, phone: "555-0100", city: "Austin", address: "123 Fictional Street" };
	const answers = [{ question: "Email", answer: "candidate@example.test" }];
	const result = await engine.fill(document, { ...packet, profile: completeProfile, answers });
	assert.equal(result.filled.length, 0);
	assert.ok(fields.every(field => field.value === ""));
	const preview = engine.plan(document, packet);
	await engine.fill(document, { ...packet, answers: [{ question: "Email", answer: "reference@example.test", fieldId: preview.fields[0].id }] });
	assert.equal(fields[0].value, "reference@example.test");
	assert.ok(fields.slice(1).every(field => field.value === ""));
});

test("a job-specific company interest answer remains supported", async () => {
	const { document, fields, engine } = environment([{ label: "Why this company?", tag: "TEXTAREA" }]);
	await engine.fill(document, { ...packet, answers: [{ question: "Why this company?", answer: "Its robotics work fits my experience.", applicationId: "application-one" }] });
	assert.equal(fields[0].value, "Its robotics work fits my experience.");
});

test("repeated history questions cannot reuse one approved answer across different entries", async () => {
	const { document, fields, engine } = environment([
		{ label: "Company name", name: "employer-1" }, { label: "Company name", name: "employer-2" },
		{ label: "Job title", name: "title-1" }, { label: "Job title", name: "title-2" },
	]);
	const answers = [{ question: "Company name", answer: "Example employer", applicationId: "application-one" },
		{ question: "Job title", answer: "Engineer" }];
	const result = await engine.fill(document, { ...packet, answers });
	assert.equal(result.filled.length, 0);
	assert.ok(result.unmatched.every(field => /repeats/.test(field.reason)));
	assert.ok(fields.every(field => field.value === ""));
	const preview = engine.plan(document, packet);
	await engine.fill(document, { ...packet, answers: [{ ...answers[0], fieldId: preview.fields[0].id }] });
	assert.deepEqual(fields.map(field => field.value), ["Example employer", "", "", ""]);
});

test("an earlier field's change handler cannot cause later prefilled values to be overwritten", async () => {
	const { document, fields, engine } = environment([{ label: "First name" }, { label: "Last name" }]);
	const originalDispatch = fields[0].dispatchEvent.bind(fields[0]);
	fields[0].dispatchEvent = event => { if (event.type === "change") fields[1].value = "Set by the website"; return originalDispatch(event); };
	await engine.fill(document, packet);
	assert.equal(fields[1].value, "Set by the website");
});

test("stale preview and page navigation reject every write", async () => {
	const { document, fields, engine } = environment([{ label: "First name" }]);
	const preview = engine.plan(document, packet);
	await assert.rejects(engine.fill(document, packet, { expectedFingerprint: "previous-form" }), /fields changed/);
	document.title = "Another employer application";
	await assert.rejects(engine.fill(document, packet, { expectedFingerprint: preview.fingerprint }), /fields changed/);
	document.URL = "https://different.example.test/apply";
	await assert.rejects(engine.fill(document, packet, { expectedUrl: preview.pageUrl }), /page changed/);
	assert.equal(fields[0].value, "");
});

test("only clearly labelled resume uploads receive the selected PDF; invalid signatures stay unattached", async () => {
	const { document, fields, engine } = environment([{ label: "Resume", type: "file", accept: ".pdf" }, { label: "Cover letter", type: "file" }]);
	const resume = { base64: Buffer.from("%PDF-1.4\nFictional fixture").toString("base64"), fileName: "Example-Engineer.pdf", mimeType: "application/pdf" };
	const result = await engine.fill(document, { ...packet, resume });
	assert.equal(fields[0].files[0].name, "Example-Engineer.pdf");
	assert.equal(await fields[0].files[0].text(), "%PDF-1.4\nFictional fixture");
	assert.equal(fields[1].files.length, 0);
	assert.match(result.filled[0].note, /Verify.*uploading/);
	const bad = environment([{ label: "Resume", type: "file" }]);
	const invalid = await bad.engine.fill(bad.document, { ...packet, resume: { ...resume, base64: Buffer.from("Not PDF").toString("base64") } });
	assert.equal(bad.fields[0].files.length, 0);
	assert.equal(invalid.failed.length, 1);
});

test("radio questions use their group label and an explicit approved answer", async () => {
	const fieldset = { querySelector: selector => selector === "legend" ? { innerText: "Will you require visa sponsorship?" } : null };
	const { document, fields, engine } = environment([
		{ label: "Yes", type: "radio", name: "sponsorship", value: "yes", fieldset },
		{ label: "No", type: "radio", name: "sponsorship", value: "no", fieldset },
	]);
	assert.equal(engine.scan(document).length, 1);
	await engine.fill(document, { ...packet, answers: [{ question: "Will you require visa sponsorship?", answer: "No", applicationId: "application-one" }] });
	assert.equal(fields[0].checked, false);
	assert.equal(fields[1].checked, true);
	assert.equal(fields[1].clicks, 1);
});

test("checkbox and radio choice state uses native clicks rather than checked setters", async () => {
	const { document, fields, engine } = environment([{ label: "I agree to the terms", type: "checkbox" }]);
	let controlledState = false;
	const dispatch = fields[0].dispatchEvent.bind(fields[0]);
	fields[0].dispatchEvent = event => { if (event.type === "click") controlledState = fields[0].checked; return dispatch(event); };
	await engine.fill(document, { ...packet, answers: [{ question: "I agree to the terms", answer: "Yes" }] });
	assert.equal(fields[0].clicks, 1);
	assert.equal(controlledState, true);
	assert.equal(fields[0].checked, true);
	await engine.fill(document, { ...packet, answers: [{ question: "I agree to the terms", answer: "Yes" }] });
	assert.equal(fields[0].clicks, 1, "Existing approved choices stay unchanged rather than toggling twice.");
});

test("a button with aria-haspopup=listbox is discovered without a combobox role", async () => {
	const { document, fields, engine } = environment([{ label: "Country", tag: "BUTTON", type: "button", attributes: { "aria-haspopup": "listbox" } }]);
	const scan = engine.scan(document);
	assert.equal(scan.length, 1);
	assert.equal(scan[0].type, "combobox");
	assert.equal(engine.plan(document, packet).fields[0].matched, true);
	assert.equal(fields[0].clicks, 0, "Scanning must not open or activate the dropdown.");
});

test("wrapping labels exclude select option content and described help text", async () => {
	const label = { nodeType: 1, tagName: "LABEL", getAttribute: () => null, childNodes: [
		{ nodeType: 3, nodeValue: "Country " },
		{ nodeType: 1, tagName: "SELECT", getAttribute: () => null, childNodes: [{ nodeType: 3, nodeValue: "Select country United States Canada" }] },
		{ nodeType: 1, tagName: "SPAN", id: "country-help", getAttribute: () => null, childNodes: [{ nodeType: 3, nodeValue: "Please choose your country" }] },
	] };
	const { document, fields, engine } = environment([{ tag: "SELECT", labelNode: label, attributes: { "aria-describedby": "country-help" },
		options: [{ label: "Select country", value: "" }, { label: "United States", value: "US" }] }]);
	assert.equal(engine.scan(document)[0].label, "Country");
	await engine.fill(document, packet);
	assert.equal(fields[0].value, "US");
});

test("a custom dropdown button capable of submission is never clicked", async () => {
	const { document, fields, engine } = environment([{ label: "Favorite framework", tag: "BUTTON", type: "submit", attributes: { role: "combobox" } }]);
	const result = await engine.fill(document, { ...packet, answers: [{ question: "Favorite framework", answer: "React" }] });
	assert.equal(fields[0].clicks, 0);
	assert.equal(result.unsupported.length, 1);
	assert.match(result.unsupported[0].reason, /submit/);
});

test("unmatched ARIA autocomplete query is restored instead of being reported as a selection", async () => {
	const { document, fields, engine } = environment([{ label: "Favorite framework", attributes: { role: "combobox" } }]);
	const result = await engine.fill(document, { ...packet, answers: [{ question: "Favorite framework", answer: "React" }] });
	assert.equal(fields[0].value, "");
	assert.equal(result.filled.length, 0);
	assert.equal(result.unsupported.length, 1);
	assert.match(result.unsupported[0].reason, /option/);
});
