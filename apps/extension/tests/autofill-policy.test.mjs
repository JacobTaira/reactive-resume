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
		this.innerText = options.text || "";
		this.ashbyWrapper = options.ashbyWrapper || null;
		this.entry = options.entry || null;
		this.booleanContainer = options.booleanContainer || null;
		this.radioGroup = options.radioGroup || null;
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
		this.form = Object.hasOwn(options, "form") ? options.form : document.form;
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
	closest(selector) {
		if (selector === "fieldset") return this.fieldset || null;
		if (selector === ".ashby-application-form-field-entry") return this.ashbyWrapper;
		if (selector === '[data-field-path][data-field-entry-id]') return this.entry;
		if (selector === '[class*="_yesno_"]') return this.booleanContainer;
		if (selector === "form") return this.closestForm || null;
		if (selector.includes('[role="radiogroup"]')) return this.radioGroup;
		return null;
	}
	querySelector() { return null; }
	dispatchEvent(event) { this.events.push(event.type); return true; }
	click() {
		this.clicks++;
		if (this.onClick) { this.onClick(); return; }
		if (this.type === "radio" || this.type === "checkbox") {
			this.checked = this.type === "radio" || !this.checked;
			for (const type of ["click", "input", "change"]) this.dispatchEvent(new FixtureEvent(type));
		} else if (this.getAttribute("role") === "radio") {
			for (const element of this.ownerDocument.controls) {
				if (element.radioGroup === this.radioGroup) element.attributes["aria-checked"] = element === this ? "true" : "false";
			}
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

function questionWrapper(title, { duplicateTitle = false } = {}) {
	const wrapper = { tagName: "DIV", nodeType: 1, children: [], parentElement: null, id: `wrapper-${title}`,
		getAttribute: () => null, getRootNode: () => ({}), querySelector: () => null, querySelectorAll: () => [] };
	const heading = { innerText: title, closest: () => wrapper };
	wrapper.querySelectorAll = (selector) => selector === ".ashby-application-form-question-title" ? (duplicateTitle ? [heading, { ...heading }] : [heading]) : [];
	return wrapper;
}

// Independently authored fixtures of observed Ashby markup. Its native choice
// title is a LABEL in a FIELDSET (no legend); Yes/No uses two raw buttons and an
// answered-state checkbox. No third-party autofill implementation is copied.
function capturedQuestion(title, { path = "question-one", entryId = "entry-question-one", duplicateTitle = false, titleFor = path, native = false } = {}) {
	const entry = { tagName: "DIV", id: entryId, nodeType: 1, children: [], parentElement: null, isConnected: true,
		getAttribute: (key) => ({ "data-field-path": path, "data-field-entry-id": entryId })[key] || null,
		getRootNode: () => ({}), querySelector: () => entry.buttons?.[0] || null, querySelectorAll: () => [],
		closest: (selector) => selector === '[data-field-path][data-field-entry-id]' || !native && selector === ".ashby-application-form-field-entry" ? entry : null };
	const fieldset = { tagName: "FIELDSET", id: "", nodeType: 1, children: [], parentElement: entry,
		getAttribute: () => null, getRootNode: () => ({}), querySelector: () => null, querySelectorAll: () => [],
		closest: (selector) => selector === "fieldset" ? fieldset : selector === '[data-field-path][data-field-entry-id]' ? entry : null };
	const heading = { innerText: title, getAttribute: (key) => key === "for" ? titleFor : null,
		closest: (selector) => selector === "fieldset" ? native ? fieldset : null : selector === '[data-field-path][data-field-entry-id]' ? entry : !native && selector === ".ashby-application-form-field-entry" ? entry : null };
	const titles = duplicateTitle ? [heading, { ...heading }] : [heading];
	entry.querySelectorAll = (selector) => selector === ".ashby-application-form-question-title" ? titles : selector === '[class*="_yesno_"]' ? [entry.container] : [];
	fieldset.querySelectorAll = (selector) => selector === ".ashby-application-form-question-title" ? titles : [];
	return { entry, fieldset, titles, path, entryId };
}

function booleanEnvironment({ selected = "", checkboxName, duplicateTitle = false, form = null, explicitType, retain = true } = {}) {
	const shape = capturedQuestion("Prior Government Employment?", { duplicateTitle });
	const { entry } = shape;
	const container = { tagName: "DIV", nodeType: 1, id: "", children: [], parentElement: entry,
		getAttribute: (key) => key === "class" ? "_container_fixture _yesno_fixture" : null, getRootNode: () => ({}), querySelector: () => null,
		querySelectorAll: (selector) => selector === "button" ? entry.buttons : selector === 'input[type="checkbox"]' ? [entry.backing] : [],
		closest: (selector) => selector === '[data-field-path][data-field-entry-id]' ? entry : null };
	entry.container = container;
	const definitions = ["Yes", "No"].map((label) => ({ tag: "BUTTON", type: explicitType || "submit", text: label, entry, ashbyWrapper: entry, booleanContainer: container, parent: container, form,
		attributes: { class: `_container_fixture _option_fixture${selected === label ? " _active_fixture" : ""}`, ...(explicitType ? { type: explicitType } : {}) } }));
	definitions.push({ type: "checkbox", name: checkboxName || shape.path, value: selected || "on", checked: Boolean(selected), entry, ashbyWrapper: entry, booleanContainer: container, parent: container, form });
	const subject = environment(definitions);
	entry.buttons = subject.fields.slice(0, 2); entry.backing = subject.fields[2];
	for (const button of entry.buttons) button.onClick = () => {
		if (!retain) return;
		entry.backing.checked = true; entry.backing.value = button.innerText;
		for (const choice of entry.buttons) choice.attributes.class = `_container_fixture _option_fixture${choice === button ? " _active_fixture" : ""}`;
	};
	return { ...subject, ...shape };
}

test("observed Ashby fieldset LABEL titles identify native Gender, Race and Veteran Status groups", async () => {
	const shapes = [capturedQuestion("Gender", { native: true, path: "gender", entryId: "survey-gender" }),
		capturedQuestion("Race", { native: true, path: "race", entryId: "survey-race" }),
		capturedQuestion("Veteran Status", { native: true, path: "veteran", entryId: "survey-veteran" })];
	const answers = ["Male", "Asian (Not Hispanic or Latino)", "I am not a protected veteran"];
	const definitions = shapes.flatMap((shape, index) => [answers[index], "Decline to self-identify"].map((label, option) => ({ label, type: "radio", name: shape.entryId, value: String(option), entry: shape.entry, fieldset: shape.fieldset, parent: shape.fieldset })));
	const { document, fields, engine } = environment(definitions);
	const value = { ...packet, commonAnswers: { gender: answers[0], race: answers[1], protectedVeteranStatus: answers[2] } };
	assert.deepEqual(Array.from(engine.plan(document, value).fields, field => field.label), ["Gender", "Race", "Veteran Status"]);
	const result = await engine.fill(document, value);
	assert.equal(result.filled.length, 3);
	assert.deepEqual(fields.map(field => field.checked), [true, false, true, false, true, false]);
});

test("Ashby native title path mismatches and duplicate question titles stay manual", async () => {
	for (const options of [{ titleFor: "other-question" }, { duplicateTitle: true }]) {
		const shape = capturedQuestion("Gender", { native: true, ...options });
		const { document, fields, engine } = environment([{ label: "Male", type: "radio", name: shape.entryId, value: "male", entry: shape.entry, fieldset: shape.fieldset, parent: shape.fieldset }]);
		const result = await engine.fill(document, { ...packet, commonAnswers: { gender: "Male" }, answers: [{ question: "Male", answer: "male" }] });
		assert.equal(result.filled.length, 0); assert.equal(fields[0].clicks, 0);
	}
});

test("observed no-type Ashby Yes/No buttons fill an approved No by clicking while marking the backing checkbox answered", async () => {
	const { document, fields, engine, entry } = booleanEnvironment();
	const value = { ...packet, commonAnswers: { priorGovernmentEmployment: "No" } };
	const plan = engine.plan(document, value);
	assert.equal(plan.fields.length, 1); assert.equal(plan.fields[0].label, "Prior Government Employment?");
	assert.equal(plan.fields[0].type, "ashby-boolean"); assert.equal(plan.matched.length, 1);
	const result = await engine.fill(document, value);
	assert.equal(result.filled.length, 1);
	assert.equal(fields[0].clicks, 0); assert.equal(fields[1].clicks, 1);
	assert.equal(entry.backing.checked, true); assert.equal(entry.backing.value, "No");
});

test("an unchecked Ashby backing checkbox is unanswered rather than an implicit No", async () => {
	const subject = booleanEnvironment();
	assert.equal(subject.engine.plan(subject.document, packet).matched.length, 0);
	await subject.engine.fill(subject.document, packet);
	assert.ok(subject.fields.every(field => field.clicks === 0));
	assert.equal(subject.entry.backing.checked, false);
});

test("existing active Yes and No are preserved even when another common answer is approved", async () => {
	for (const selected of ["Yes", "No"]) {
		const subject = booleanEnvironment({ selected });
		const value = { ...packet, commonAnswers: { priorGovernmentEmployment: selected === "Yes" ? "No" : "Yes" } };
		assert.equal(subject.engine.plan(subject.document, value).fields[0].status, "preserved");
		await subject.engine.fill(subject.document, value);
		assert.ok(subject.fields.every(field => field.clicks === 0));
		assert.equal(subject.entry.backing.value, selected);
	}
});

test("Ashby Yes/No groups with mismatched backing paths or duplicate titles are not filled", async () => {
	for (const options of [{ checkboxName: "other-question" }, { duplicateTitle: true }]) {
		const subject = booleanEnvironment(options);
		await subject.engine.fill(subject.document, { ...packet, commonAnswers: { priorGovernmentEmployment: "No" } });
		assert.ok(subject.fields.every(field => field.clicks === 0));
	}
});

test("Ashby button clicks must survive actual selection-state readback", async () => {
	const subject = booleanEnvironment({ retain: false });
	const result = await subject.engine.fill(subject.document, { ...packet, commonAnswers: { priorGovernmentEmployment: "No" } });
	assert.equal(result.filled.length, 0); assert.equal(result.failed.length, 1);
	assert.match(result.failed[0].reason, /did not retain/);
});

test("raw Ashby submit-capable buttons with a native form are never clicked", async () => {
	for (const options of [{ form: { id: "native-form" } }, { explicitType: "submit" }]) {
		const subject = booleanEnvironment(options);
		await subject.engine.fill(subject.document, { ...packet, commonAnswers: { priorGovernmentEmployment: "No" } });
		assert.ok(subject.fields.every(field => field.clicks === 0));
	}
});

test("Ashby option buttons that become form-associated after preview are refused before clicking", async () => {
	const subject = booleanEnvironment();
	const value = { ...packet, commonAnswers: { priorGovernmentEmployment: "No" } };
	const plan = subject.engine.plan(subject.document, value);
	for (const button of subject.entry.buttons) button.form = { id: "new-native-form" };
	const result = await subject.engine.fill(subject.document, value, { expectedFingerprint: plan.fingerprint });
	assert.equal(result.filled.length, 0); assert.ok(subject.fields.every(field => field.clicks === 0));
});

test("common answers require explicit saved values and recognize only narrow equivalent questions", async () => {
	const definitions = [
		{ label: "How did you find about Example Robotics?" },
		{ label: "Prior Government Employment?", name: "priorGovernmentEmployment", tag: "SELECT", options: [{ label: "Select", value: "" }, { label: "Yes", value: "yes" }, { label: "No", value: "no" }] },
		{ label: "Gender", tag: "SELECT", options: [{ label: "Select", value: "" }, { label: "Man", value: "man" }, { label: "Woman", value: "woman" }] },
		{ label: "Race", tag: "SELECT", options: [{ label: "Select", value: "" }, { label: "Asian (Not Hispanic or Latino)", value: "asian" }] },
		{ label: "Veteran Status", tag: "SELECT", options: [{ label: "Select", value: "" }, { label: "I identify as one or more of the classifications of protected veteran listed above", value: "protected" }, { label: "I am not a protected veteran", value: "not-protected" }] },
	];
	const blank = environment(definitions);
	assert.equal(blank.engine.plan(blank.document, packet).matched.length, 0);
	const { document, fields, engine } = environment(definitions);
	const commonAnswers = { jobSource: "My own search", priorGovernmentEmployment: "No", gender: "Male", race: "Asian (Not Hispanic or Latino)", protectedVeteranStatus: "I identify as a protected veteran" };
	const result = await engine.fill(document, { ...packet, commonAnswers });
	assert.equal(result.filled.length, 5);
	assert.deepEqual(fields.map(field => field.value), ["My own search", "no", "man", "asian", "protected"]);
});

test("common answers never conflate government, gender, ethnicity, military-service or reference questions", async () => {
	const { document, fields, engine } = environment([
		{ label: "Current Government Employment?" }, { label: "Prior Federal Government Employment?" },
		{ label: "Has your spouse ever worked for the government?" }, { label: "Sex assigned at birth" },
		{ label: "Are you Hispanic or Latino?" }, { label: "Ethnicity" }, { label: "Have you ever served in the military?" },
		{ label: "Veteran status", tag: "SELECT", options: [{ label: "Select", value: "" }, { label: "Veteran", value: "veteran" }, { label: "Not a veteran", value: "not-veteran" }] },
		{ label: "Referral name" }, { label: "How did you hear about Another Company?" },
		{ label: "Gender", heading: "Reference" }, { label: "Prior Government Employment?", heading: "Reference" },
		{ label: "Race", type: "checkbox" },
	]);
	const result = await engine.fill(document, { ...packet, commonAnswers: { jobSource: "Job board", priorGovernmentEmployment: "No", gender: "Male", race: "Asian (Not Hispanic or Latino)", protectedVeteranStatus: "I am not a protected veteran" } });
	assert.equal(result.filled.length, 0);
	assert.ok(fields.every(field => field.value === "" && !field.checked && !field.clicks));
});

test("exact answers override common values and conflicts or repeated questions never fall back", async () => {
	const { document, fields, engine } = environment([
		{ label: "Gender" }, { label: "Prior Government Employment?" }, { label: "How did you hear about us?" }, { label: "How did you hear about us?" },
	]);
	const answers = [{ question: "Gender", answer: "Female", applicationId: packet.application.id },
		{ question: "Prior Government Employment?", answer: "Yes" }, { question: "Prior Government Employment?", answer: "No" }];
	const result = await engine.fill(document, { ...packet, answers, commonAnswers: { gender: "Male", priorGovernmentEmployment: "No", jobSource: "Job board" } });
	assert.deepEqual(fields.map(field => field.value), ["Female", "", "", ""]);
	assert.equal(result.filled.length, 1);
	assert.ok(result.unmatched.some(field => /Conflicting/.test(field.reason)));
});

test("disabled exact answers veto common defaults while a more specific enabled answer can override a global disabled rule", async () => {
	const subject = environment([{ label: "Gender" }]);
	await subject.engine.fill(subject.document, { ...packet, answers: [{ question: "Gender", answer: "Female", approved: false }], commonAnswers: { gender: "Male" } });
	assert.equal(subject.fields[0].value, "");
	await subject.engine.fill(subject.document, { ...packet, answers: [{ question: "Gender", answer: "Female", approved: false }, { question: "Gender", answer: "Female", applicationId: packet.application.id }], commonAnswers: { gender: "Male" } });
	assert.equal(subject.fields[0].value, "Female");
});

test("known EEO context permits opted-in self-identification but outer references and history contexts remain excluded", async () => {
	const reference = { tagName: "SECTION", nodeType: 1, id: "references", children: [], parentElement: null, getAttribute: () => null, getRootNode: () => ({}), querySelector: () => ({ innerText: "References" }) };
	const inner = { tagName: "FIELDSET", nodeType: 1, id: "reference-gender", children: [], parentElement: reference, getAttribute: () => null, getRootNode: () => ({}), querySelector: () => ({ innerText: "Gender" }) };
	const { document, fields, engine } = environment([
		{ label: "Gender", heading: "U.S. Equal Employment Opportunity Information (Completion is voluntary and will not subject you to adverse treatment)" },
		{ label: "Gender", parent: inner },
	]);
	const result = await engine.fill(document, { ...packet, commonAnswers: { gender: "Female" } });
	// The repeated question itself also prevents a broad answer from filling both.
	assert.equal(result.filled.length, 0);
	assert.equal(fields[1].value, "");
	const eeo = environment([{ label: "Gender", heading: "U.S. Equal Employment Opportunity Information (Completion is voluntary and will not subject you to adverse treatment)" }]);
	await eeo.engine.fill(eeo.document, { ...packet, commonAnswers: { gender: "Female" } });
	assert.equal(eeo.fields[0].value, "Female");
	const isolatedReference = environment([{ label: "Gender", parent: inner }]);
	await isolatedReference.engine.fill(isolatedReference.document, { ...packet, commonAnswers: { gender: "Female" } });
	assert.equal(isolatedReference.fields[0].value, "");
});

test("equivalent common option labels must identify exactly one option", async () => {
	const { document, fields, engine } = environment([
		{ label: "Gender", tag: "SELECT", options: [{ label: "Select", value: "" }, { label: "Male", value: "male" }, { label: "Man", value: "man" }] },
		{ label: "Race", tag: "SELECT", options: [{ label: "Select", value: "" }, { label: "Asian", value: "asian" }] },
		{ label: "Protected veteran status", tag: "SELECT", options: [{ label: "Select", value: "" }, { label: "I prefer not to answer", value: "decline" }] },
	]);
	const result = await engine.fill(document, { ...packet, commonAnswers: { gender: "Male", race: "Asian (Not Hispanic or Latino)", protectedVeteranStatus: "I decline to self-identify for protected veteran status" } });
	assert.deepEqual(fields.map(field => field.value), ["", "", "decline"]);
	assert.equal(result.filled.length, 1);
	assert.equal(result.unsupported.length, 2);
});

test("Ashby wrapper titles label native radio groups without including descriptions or option labels", async () => {
	const gender = questionWrapper("Gender"), race = questionWrapper("Race");
	const { document, fields, engine } = environment([
		{ type: "radio", name: "gender", value: "male", label: "Male", parent: gender, ashbyWrapper: gender },
		{ type: "radio", name: "gender", value: "female", label: "Female", parent: gender, ashbyWrapper: gender },
		{ type: "radio", name: "race", value: "asian", label: "Asian (Not Hispanic or Latino)", parent: race, ashbyWrapper: race },
	]);
	const plan = engine.plan(document, { ...packet, commonAnswers: { gender: "Female", race: "Asian (Not Hispanic or Latino)" } });
	assert.deepEqual(Array.from(plan.fields, field => field.label), ["Gender", "Race"]);
	await engine.fill(document, { ...packet, commonAnswers: { gender: "Female", race: "Asian (Not Hispanic or Latino)" } });
	assert.deepEqual(fields.map(field => field.checked), [false, true, true]);
});

test("Ashby wrappers with duplicate titles or shared cross-question radio names stay manual", async () => {
	const duplicate = questionWrapper("Gender", { duplicateTitle: true });
	const first = questionWrapper("Gender"), second = questionWrapper("Protected veteran status");
	const { document, fields, engine } = environment([
		{ type: "radio", name: "duplicate", value: "female", label: "Female", parent: duplicate, ashbyWrapper: duplicate },
		{ type: "radio", name: "shared", value: "male", label: "Male", parent: first, ashbyWrapper: first },
		{ type: "radio", name: "shared", value: "no", label: "I am not a protected veteran", parent: second, ashbyWrapper: second },
	]);
	const result = await engine.fill(document, { ...packet, commonAnswers: { gender: "Female", protectedVeteranStatus: "I am not a protected veteran" } });
	assert.equal(result.filled.length, 0);
	assert.ok(fields.every(field => !field.checked && !field.clicks));
});

test("explicit ARIA radio groups use approved common answers but never submit-capable buttons", async () => {
	const group = { getAttribute: (key) => key === "aria-label" ? "Gender" : null };
	const unsafe = { getAttribute: (key) => key === "aria-label" ? "Prior Government Employment?" : null };
	const { document, fields, engine } = environment([
		{ tag: "BUTTON", type: "button", attributes: { role: "radio", "aria-checked": "false" }, text: "Male", radioGroup: group },
		{ tag: "BUTTON", type: "button", attributes: { role: "radio", "aria-checked": "false" }, text: "Female", radioGroup: group },
		{ tag: "BUTTON", type: "submit", attributes: { role: "radio", "aria-checked": "false" }, text: "No", radioGroup: unsafe },
	]);
	const result = await engine.fill(document, { ...packet, commonAnswers: { gender: "Female", priorGovernmentEmployment: "No" } });
	assert.equal(result.filled.length, 1);
	assert.equal(fields[1].getAttribute("aria-checked"), "true");
	assert.equal(fields[2].clicks, 0);
});

test("checked disabled or hidden peers preserve a radio group's existing answer", async () => {
	for (const omitted of [{ disabled: true }, { hidden: true }]) {
		const wrapper = questionWrapper("Gender");
		const { document, fields, engine } = environment([
			{ type: "radio", name: "gender", value: "female", label: "Female", checked: true, ...omitted, parent: wrapper, ashbyWrapper: wrapper },
			{ type: "radio", name: "gender", value: "male", label: "Male", parent: wrapper, ashbyWrapper: wrapper },
		]);
		const plan = engine.plan(document, { ...packet, commonAnswers: { gender: "Male" } });
		assert.equal(plan.fields[0].status, "preserved");
		await engine.fill(document, { ...packet, commonAnswers: { gender: "Male" } });
		assert.deepEqual(fields.map(field => field.checked), [true, false]);
		assert.ok(fields.every(field => !field.clicks));
	}
});

test("disabled radio options are not selected or allowed to shift the chosen visible option index", async () => {
	const wrapper = questionWrapper("Gender");
	const { document, fields, engine } = environment([
		{ type: "radio", name: "gender", value: "male", label: "Male", disabled: true, parent: wrapper, ashbyWrapper: wrapper },
		{ type: "radio", name: "gender", value: "female", label: "Female", parent: wrapper, ashbyWrapper: wrapper },
	]);
	await engine.fill(document, { ...packet, commonAnswers: { gender: "Female" } });
	assert.deepEqual(fields.map(field => field.checked), [false, true]);
	assert.equal(fields[0].clicks, 0);
});

test("protected-veteran answers match Yes/No only for an explicitly protected-veteran question", async () => {
	const options = [{ label: "Select", value: "" }, { label: "Yes", value: "yes" }, { label: "No", value: "no" }];
	const { document, fields, engine } = environment([
		{ label: "Are you a protected veteran?", tag: "SELECT", options },
		{ label: "Are you a veteran?", tag: "SELECT", options },
	]);
	await engine.fill(document, { ...packet, commonAnswers: { protectedVeteranStatus: "I am not a protected veteran" } });
	assert.deepEqual(fields.map(field => field.value), ["no", ""]);
});

test("own screening question legends do not become employer history context", async () => {
	const government = { querySelector: () => ({ innerText: "Prior Government Employment?" }) };
	const source = { querySelector: () => ({ innerText: "How did you hear about this company?" }) };
	const { document, fields, engine } = environment([
		{ type: "radio", name: "government", label: "Yes", value: "yes", heading: "Prior Government Employment?", fieldset: government },
		{ type: "radio", name: "government", label: "No", value: "no", heading: "Prior Government Employment?", fieldset: government },
		{ type: "radio", name: "source", label: "Job board", value: "board", heading: "How did you hear about this company?", fieldset: source },
	]);
	await engine.fill(document, { ...packet, commonAnswers: { priorGovernmentEmployment: "No", jobSource: "Job board" } });
	assert.deepEqual(fields.map(field => field.checked), [false, true, true]);
});

test("meaningful empty-value select choices are preserved and duplicate target values stay unsupported", async () => {
	const { document, fields, engine } = environment([
		{ label: "Gender", tag: "SELECT", value: "", options: [{ label: "Prefer not to answer", value: "" }, { label: "Female", value: "female" }] },
		{ label: "Protected veteran status", tag: "SELECT", value: "placeholder", options: [{ label: "Select", value: "placeholder" }, { label: "I am not a protected veteran", value: "shared" }, { label: "I identify as a protected veteran", value: "shared" }] },
		{ label: "Gender identity", tag: "SELECT", value: "placeholder", options: [{ label: "Select", value: "placeholder" }, { label: "Male", value: "shared", disabled: true }, { label: "Female", value: "shared" }] },
	]);
	const plan = engine.plan(document, { ...packet, commonAnswers: { gender: "Female", protectedVeteranStatus: "I am not a protected veteran" } });
	assert.equal(plan.fields[0].status, "preserved");
	assert.equal(plan.fields[1].status, "unsupported");
	assert.equal(plan.fields[2].status, "unsupported");
	await engine.fill(document, { ...packet, commonAnswers: { gender: "Female", protectedVeteranStatus: "I am not a protected veteran" } });
	assert.deepEqual(fields.map(field => field.value), ["", "placeholder", "placeholder"]);
});

test("profile values do not fill locations within work-experience sections", async () => {
	const { document, fields, engine } = environment([{ label: "City", heading: "Work Experience", attributes: { autocomplete: "address-level2" } }]);
	await engine.fill(document, { ...packet, profile: { ...packet.profile, city: "Austin" } });
	assert.equal(fields[0].value, "");
});

test("a separate cover-letter PDF fills only clearly labelled cover-letter uploads", async () => {
	const { document, fields, engine } = environment([
		{ type: "file", label: "Resume" }, { type: "file", label: "Cover Letter" }, { type: "file", label: "Upload file" },
		{ type: "file", label: "Resume or cover letter" }, { type: "file", label: "Cover Letter", heading: "Reference" },
	]);
	const resume = { base64: btoa("%PDF-1.7\nresume contents"), fileName: "Resume.pdf" };
	const coverLetter = { base64: btoa("%PDF-1.7\ncover letter contents"), fileName: "Cover.pdf" };
	const withoutCover = engine.plan(document, { ...packet, resume });
	assert.equal(withoutCover.fields[1].status, "unmatched");
	const result = await engine.fill(document, { ...packet, resume, coverLetter });
	assert.equal(result.filled.length, 2);
	assert.deepEqual(fields.map(field => field.files[0]?.name || ""), ["Resume.pdf", "Cover.pdf", "", "", ""]);
	assert.equal(await fields[0].files[0].text(), "%PDF-1.7\nresume contents");
	assert.equal(await fields[1].files[0].text(), "%PDF-1.7\ncover letter contents");
});

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
