import assert from "node:assert/strict";
import test from "node:test";
import { COMMON_ANSWER_FIELDS } from "../src/autofill-common.js";
import { mountAutofillSettings } from "../src/autofill-settings.js";

// Run the actual settings controller. Chrome messaging/permissions and the small
// form DOM are adapters; verify the user's saved values and approval boundaries.
class Element {
	constructor(tagName = "DIV") {
		Object.assign(this, { tagName, id: "", value: "", textContent: "", className: "", children: [], listeners: {}, attributes: {}, disabled: false });
	}
	append(...children) { this.children.push(...children); }
	setAttribute(name, value) { this.attributes[name] = value; }
	addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
	async emit(type) { for (const listener of this.listeners[type] || []) await listener({ preventDefault() {} }); }
}

async function fixture(overrides = {}, { allowPermission = true, stateError = null } = {}) {
	const state = { baseUrl: "http://localhost:3000", configured: false, profile: {}, answers: [], ...overrides };
	const calls = [], grants = [];
	const roots = Object.fromEntries(["settings", "settings-fields", "profile", "common-answers", "base-url", "api-key", "answers", "connection", "message"]
		.map((id) => { const node = new Element(); node.id = id; return [id, node]; }));
	roots["settings-fields"].disabled = true;
	function find(node, id) {
		if (node.id === id) return node;
		for (const child of node.children) { const match = find(child, id); if (match) return match; }
		return null;
	}
	const document = {
		createElement: (tag) => new Element(tag.toUpperCase()),
		getElementById: (id) => roots[id] || Object.values(roots).map((root) => find(root, id)).find(Boolean) || null,
	};
	const chromeApi = {
		permissions: { request: async (value) => { grants.push(structuredClone(value)); return allowPermission; } },
		runtime: { sendMessage: async (message) => {
			calls.push(structuredClone(message));
			if (message.type === "autofill-state") return stateError ? { ok: false, error: stateError } : { ok: true, data: structuredClone(state) };
			if (message.type === "autofill-save") return { ok: true, data: { configured: Boolean(message.apiKey || state.configured), message: "Approved profile and answers saved in this browser." } };
			throw new Error(`Unexpected settings message ${message.type}`);
		} },
	};
	await mountAutofillSettings({ document, chromeApi });
	return { field: document.getElementById, calls, grants, save: () => roots.settings.emit("submit") };
}

test("common answer controls start blank/manual without inferring demographic or discovery answers", async () => {
	const subject = await fixture({ profile: { firstName: "Example", email: "candidate@example.test" } });
	assert.equal(subject.field("settings-fields").disabled, false);
	for (const descriptor of COMMON_ANSWER_FIELDS) {
		const field = subject.field(`common-${descriptor.key}`);
		assert.equal(field.value, "");
		assert.equal(field.tagName, descriptor.choices ? "SELECT" : "INPUT");
		if (descriptor.choices) {
			assert.equal(field.children[0].value, "");
			assert.equal(field.children[0].textContent, "Leave manual");
			assert.deepEqual(field.children.slice(1).map((option) => option.value), descriptor.choices);
		}
		assert.equal(field.attributes["aria-describedby"], `common-${descriptor.key}-hint`);
	}
	assert.equal(subject.field("firstName").value, "Example");
	assert.equal(subject.calls.filter((message) => message.type === "autofill-save").length, 0);
});

test("saved common choices restore and save alongside the profile, exact scoped JSON and normal key", async () => {
	const commonAnswers = {
		jobSource: "Example job board", priorGovernmentEmployment: "No", gender: "Decline to self-identify",
		race: "Decline to self-identify", protectedVeteranStatus: "I decline to self-identify for protected veteran status",
	};
	const answers = [{ question: "How did you hear about Example?", answer: "Company event", applicationId: "app-1", fieldId: "source-field", approved: true }];
	const subject = await fixture({ commonAnswers, answers, profile: { firstName: "Example", website: "https://candidate.example.test" }, configured: true });
	for (const { key } of COMMON_ANSWER_FIELDS) assert.equal(subject.field(`common-${key}`).value, commonAnswers[key]);
	assert.deepEqual(JSON.parse(subject.field("answers").value), answers);
	subject.field("api-key").value = "fictional-replacement-key";
	await subject.save();
	const saved = subject.calls.find((message) => message.type === "autofill-save");
	assert.deepEqual(saved.commonAnswers, commonAnswers);
	assert.deepEqual(saved.answers, answers);
	assert.equal(saved.profile.firstName, "Example");
	assert.equal(saved.profile.website, "https://candidate.example.test");
	assert.equal(saved.apiKey, "fictional-replacement-key");
	assert.equal(saved.baseUrl, "http://localhost:3000");
	assert.deepEqual(subject.grants, [{ origins: ["http://localhost:3000/*"] }]);
	assert.equal(subject.field("api-key").value, "");
	assert.equal(subject.field("settings-fields").disabled, false);
});

test("leaving a common choice blank explicitly clears it without deleting exact answers or other choices", async () => {
	const answers = [{ question: "When can you start?", answer: "Confirmed date", applicationId: "app-2", approved: false }];
	const subject = await fixture({ commonAnswers: { jobSource: "Previous source", gender: "Male", priorGovernmentEmployment: "Yes" }, answers });
	subject.field("common-jobSource").value = "";
	subject.field("common-gender").value = "";
	await subject.save();
	const saved = subject.calls.find((message) => message.type === "autofill-save");
	assert.equal(saved.commonAnswers.jobSource, "");
	assert.equal(saved.commonAnswers.gender, "");
	assert.equal(saved.commonAnswers.priorGovernmentEmployment, "Yes");
	assert.equal(saved.commonAnswers.race, "");
	assert.equal(saved.commonAnswers.protectedVeteranStatus, "");
	assert.deepEqual(saved.answers, answers);
});

test("invalid exact-answer JSON reports an error without saving or losing the edited common choices", async () => {
	const subject = await fixture();
	subject.field("common-jobSource").value = "Approved source";
	subject.field("answers").value = "not json";
	await subject.save();
	assert.equal(subject.field("common-jobSource").value, "Approved source");
	assert.match(subject.field("message").textContent, /valid JSON/);
	assert.equal(subject.field("message").className, "error");
	assert.equal(subject.calls.filter((message) => message.type === "autofill-save").length, 0);
	assert.equal(subject.grants.length, 0);
	assert.equal(subject.field("settings-fields").disabled, false);
});

test("permission denial leaves key and common choices intact without sending a save", async () => {
	const subject = await fixture({}, { allowPermission: false });
	subject.field("api-key").value = "fictional-unsaved-key";
	subject.field("common-priorGovernmentEmployment").value = "No";
	await subject.save();
	assert.equal(subject.field("api-key").value, "fictional-unsaved-key");
	assert.equal(subject.field("common-priorGovernmentEmployment").value, "No");
	assert.match(subject.field("message").textContent, /not granted/);
	assert.equal(subject.calls.filter((message) => message.type === "autofill-save").length, 0);
});

test("failed settings restoration cannot overwrite existing approvals with a blank form", async () => {
	const subject = await fixture({}, { stateError: "Saved settings could not be read." });
	assert.equal(subject.field("settings-fields").disabled, true);
	await subject.save();
	assert.equal(subject.calls.filter((message) => message.type === "autofill-save").length, 0);
	assert.match(subject.field("message").textContent, /Wait for saved settings to load/);
});
