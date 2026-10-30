import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../src/autofill-diagnostics.js", import.meta.url), "utf8");
class Element {
	constructor(tag, attributes = {}, content = "") {
		this.tagName = tag.toUpperCase(); this.nodeType = 1; this.attributes = attributes; this.children = [];
		this.childNodes = content ? [{ nodeType: 3, nodeValue: content }] : [];
		this.type = attributes.type || (this.tagName === "BUTTON" ? "submit" : "");
		this.id = attributes.id || ""; this.labels = []; this.hidden = false;
	}
	getAttribute(name) { return this.attributes[name] ?? null; }
	hasAttribute(name) { return name in this.attributes; }
	append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); this.childNodes.push(node); } }
	getRootNode() { let node = this; while (node.parentElement) node = node.parentElement; return node; }
	matches(selector) {
		return selector.split(",").some((part) => {
			part = part.trim();
			if (part === "*") return true;
			if (part.startsWith(".")) return (this.attributes.class || "").split(/\s+/).includes(part.slice(1));
			if (part.startsWith("[")) return [...part.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)].every(([, key, value]) => value === undefined ? this.hasAttribute(key) : this.getAttribute(key) === value);
			return this.tagName.toLowerCase() === part.toLowerCase();
		});
	}
	closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
	querySelectorAll(selector) { return this.children.flatMap((node) => [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)]); }
	querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
	getElementById(id) { return this.querySelectorAll("*").find((node) => node.id === id) || null; }
	get options() { return this.children.filter((node) => node.tagName === "OPTION"); }
}
function forbid(node) {
	for (const key of ["value", "checked", "files", "selectedOptions", "outerHTML", "innerHTML"]) Object.defineProperty(node, key, { get() { throw new Error(`Forbidden ${key} read`); } });
	return node;
}
function environment() {
	const document = new Element("html");
	document.URL = "https://jobs.example.test/private-path?token=private#secret";
	Object.defineProperty(document, "cookie", { get() { throw new Error("Forbidden cookie read"); } });
	const context = vm.createContext({ URL }); vm.runInContext(source, context);
	return { document, inspect: context.ReactiveResumeDiagnostics.inspect };
}

test("diagnostics capture bounded question/button structure without reading entered values or selection state", () => {
	const { document, inspect } = environment();
	const group = new Element("fieldset", { "data-field-path": "private-input-path", "data-field-entry-id": "private-entry-id", class: "_fieldEntry_abc _active_xyz" });
	const title = new Element("label", { id: "private-title-id", class: "ashby-application-form-question-title" }, "Gender");
	const first = forbid(new Element("button", { type: "button", "aria-pressed": "true", class: "_option_abc _selected_xyz _active_xyz" }, "Option A"));
	const second = forbid(new Element("button", { type: "button", "aria-pressed": "false", class: "_option_abc" }, "Option B"));
	group.append(title, first, second); document.append(group);
	const result = JSON.parse(JSON.stringify(inspect(document)));
	assert.equal(result.origin, "https://jobs.example.test");
	assert.equal(result.questions.length, 1);
	assert.equal(result.questions[0].label, "Gender");
	assert.deepEqual(result.questions[0].stateAttributeNames, ["aria-pressed"]);
	assert.deepEqual(result.questions[0].controls.map((item) => item.label), ["Option A", "Option B"]);
	assert.deepEqual(result.questions[0].controls.map((item) => item.structuralHooks), [["css-module:option"], ["css-module:option"]]);
	assert.equal(result.questions[0].controls[0].groupId, result.questions[0].id);
	const serialized = JSON.stringify(result);
	for (const secret of ["private-input-path", "private-entry-id", "private-title-id", "private-path", "token", "secret", "_selected", "_active", "true", "false"]) {
		if (secret === "false") continue; // The overall truncation flag is unrelated to choice state.
		assert.equal(serialized.includes(secret), false, secret);
	}
	assert.equal(serialized.includes('"aria-pressed":"true"'), false);
});

test("native controls export local grouping and option labels while skipping hidden/password inputs and files", () => {
	const { document, inspect } = environment();
	const fieldset = new Element("fieldset"); const title = new Element("legend", {}, "Prior Government Employment?");
	const yesLabel = new Element("label", {}, "Yes"), noLabel = new Element("label", {}, "No");
	const yes = forbid(new Element("input", { type: "radio", name: "private-native-group" })); yes.labels = [yesLabel];
	const no = forbid(new Element("input", { type: "radio", name: "private-native-group" })); no.labels = [noLabel];
	fieldset.append(title, yes, yesLabel, no, noLabel);
	const select = forbid(new Element("select")); select.append(new Element("option", { value: "private-option-code" }, "Choose"), new Element("option", { value: "another-private-code" }, "Available choice"));
	const hidden = forbid(new Element("input", { type: "hidden", value: "private-token" }));
	const password = forbid(new Element("input", { type: "password", value: "private-password" }));
	const file = forbid(new Element("input", { type: "file" }));
	document.append(fieldset, select, hidden, password, file);
	const result = JSON.parse(JSON.stringify(inspect(document)));
	assert.equal(result.questions[0].label, "Prior Government Employment?");
	assert.equal(result.questions[0].controls[0].nativeGroupId, result.questions[0].controls[1].nativeGroupId);
	assert.deepEqual(result.questions[1].controls[0].options, [{ label: "Choose" }, { label: "Available choice" }]);
	assert.equal(result.questions[2].controls[0].label, "");
	const serialized = JSON.stringify(result);
	for (const secret of ["private-token", "private-password", "private-native-group", "private-option-code", "another-private-code"]) assert.equal(serialized.includes(secret), false);
});

test("Ashby fieldset title labels and implicit-type buttons retain structural form relationships", () => {
	const { document, inspect } = environment();
	const group = new Element("fieldset", { "data-field-path": "sensitive-field-key", "data-field-entry-id": "sensitive-entry-key" });
	const title = new Element("label", {}, "Prior Government Employment?");
	const yes = forbid(new Element("button", {}, "Yes")); yes.form = null;
	const no = forbid(new Element("button", {}, "No")); no.form = null;
	const form = new Element("form", { id: "sensitive-form-id" });
	const submit = forbid(new Element("button", {}, "Submit Application")); submit.form = form;
	group.append(title, yes, no); form.append(submit); document.append(group, form);
	const result = JSON.parse(JSON.stringify(inspect(document)));
	assert.equal(result.questions[0].label, "Prior Government Employment?");
	assert.equal(result.questions[0].labelSource, "question-title");
	assert.deepEqual(result.questions[0].controls.map((control) => ({ type: control.type, explicitType: control.explicitType, formId: control.formId })), [
		{ type: "submit", explicitType: null, formId: null }, { type: "submit", explicitType: null, formId: null },
	]);
	assert.match(result.questions[1].controls[0].formId, /^n\d+$/);
	for (const secret of ["sensitive-field-key", "sensitive-entry-key", "sensitive-form-id"]) assert.equal(JSON.stringify(result).includes(secret), false);
});

test("diagnostic labels redact accidental email, URL and PDF-filename text", () => {
	const { document, inspect } = environment();
	const button = forbid(new Element("button", { type: "button" }, "candidate@example.test https://example.test/private Candidate-Resume.pdf"));
	document.append(button, forbid(new Element("button", { type: "button" }, "Person Name Resume.pdf")));
	const serialized = JSON.stringify(inspect(document));
	assert.equal(serialized.includes("candidate@example.test"), false);
	assert.equal(serialized.includes("example.test/private"), false);
	assert.equal(serialized.includes("Candidate-Resume.pdf"), false);
	assert.equal(serialized.includes("Person Name"), false);
});

test("a combobox button's displayed selected value is excluded", () => {
	const { document, inspect } = environment();
	const group = new Element("fieldset"); group.append(new Element("legend", {}, "Current city"));
	const button = forbid(new Element("button", { type: "button", role: "combobox", "aria-label": "Private selected value" }, "Private selected value"));
	group.append(button); document.append(group);
	document.append(forbid(new Element("button", { type: "button", role: "combobox", "aria-label": "Standalone private selected value" }, "Standalone private selected value")));
	const serialized = JSON.stringify(inspect(document));
	assert.equal(serialized.includes("Private selected value"), false);
	assert.equal(serialized.includes("Current city"), true);
});

test("diagnostic collection is bounded for oversized forms", () => {
	const { document, inspect } = environment();
	for (let index = 0; index < 600; index++) document.append(forbid(new Element("button", { type: "button" }, "Available choice")));
	const result = inspect(document);
	assert.equal(result.questions.length, 100);
	assert.equal(result.truncated, true);
	assert.ok(JSON.stringify(result).length < 200000);
});
