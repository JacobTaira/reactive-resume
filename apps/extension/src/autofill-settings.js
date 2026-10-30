/* global chrome */
import { COMMON_ANSWER_FIELDS, approvedCommonAnswers } from "./autofill-common.js";
import { normalizedBaseUrl } from "./outbox.js";

const FIELDS = [["firstName", "First name"], ["lastName", "Last name"], ["fullName", "Full name"], ["email", "Email"], ["phone", "Phone"], ["address", "Street address"], ["city", "City"], ["state", "State or region"], ["country", "Country"], ["postalCode", "Postal code"], ["linkedin", "LinkedIn URL"], ["github", "GitHub URL"], ["website", "Website URL"]];

export async function mountAutofillSettings({ document, chromeApi }) {
	const byId = (id) => document.getElementById(id);
	let loaded = false;
	const send = async (message) => {
		const result = await chromeApi.runtime.sendMessage(message);
		if (!result?.ok) throw new Error(result?.error || "The extension worker did not respond.");
		return result.data;
	};
	const report = (text, error = false) => { byId("message").textContent = text; byId("message").className = error ? "error" : ""; };
	for (const [key, title] of FIELDS) {
		const wrapper = document.createElement("div");
		const label = document.createElement("label"); label.htmlFor = key; label.textContent = title;
		const input = document.createElement("input"); input.id = key; input.maxLength = 500; input.autocomplete = "off";
		if (key === "email") input.type = "email";
		else if (["linkedin", "github", "website"].includes(key)) input.type = "url";
		wrapper.append(label, input); byId("profile").append(wrapper);
	}
	for (const field of COMMON_ANSWER_FIELDS) {
		const wrapper = document.createElement("div");
		const label = document.createElement("label"); label.htmlFor = `common-${field.key}`; label.textContent = field.label;
		const input = document.createElement(field.choices ? "select" : "input"); input.id = label.htmlFor;
		if (field.choices) {
			for (const value of ["", ...field.choices]) {
				const option = document.createElement("option"); option.value = value; option.textContent = value || "Leave manual";
				input.append(option);
			}
		} else {
			input.type = field.type || "text"; input.maxLength = 500; input.autocomplete = "off";
			input.placeholder = "Leave blank to fill manually";
		}
		wrapper.append(label, input);
		if (field.hint) {
			const hint = document.createElement("p"); hint.id = `${input.id}-hint`; hint.className = "muted"; hint.textContent = field.hint;
			input.setAttribute("aria-describedby", hint.id); wrapper.append(hint);
		}
		byId("common-answers").append(wrapper);
	}
	byId("settings").addEventListener("submit", async (event) => {
		event.preventDefault();
		if (!loaded) { report("Wait for saved settings to load before saving.", true); return; }
		byId("settings-fields").disabled = true;
		try {
			const baseUrl = normalizedBaseUrl(byId("base-url").value);
			let answers;
			try { answers = JSON.parse(byId("answers").value || "[]"); } catch { throw new Error("Approved answers must be valid JSON: an array of question and answer objects."); }
			const commonAnswers = approvedCommonAnswers(Object.fromEntries(COMMON_ANSWER_FIELDS.map(({ key }) => [key, byId(`common-${key}`).value])));
			if (!(await chromeApi.permissions.request({ origins: [`${baseUrl}/*`] }))) throw new Error("Installation access was not granted. Settings were not changed.");
			const profile = Object.fromEntries(FIELDS.map(([key]) => [key, byId(key).value]));
			const result = await send({ type: "autofill-save", baseUrl, apiKey: byId("api-key").value, profile, answers, commonAnswers });
			byId("api-key").value = "";
			byId("connection").textContent = result.configured ? "Normal MCP key saved. Capture-only settings remain separate." : "Manual PDF mode. Add a normal MCP key when you want saved-job selection.";
			report(result.message);
		} catch (error) { report(error.message, true); }
		finally { byId("settings-fields").disabled = false; }
	});
	try {
		const state = await send({ type: "autofill-state" });
		const commonAnswers = approvedCommonAnswers(state.commonAnswers || {});
		byId("base-url").value = state.baseUrl;
		for (const [key] of FIELDS) byId(key).value = state.profile[key] || "";
		for (const { key } of COMMON_ANSWER_FIELDS) byId(`common-${key}`).value = commonAnswers[key];
		byId("answers").value = JSON.stringify(state.answers, null, 2);
		byId("connection").textContent = state.configured ? "Normal MCP key saved. Leave the key blank to keep it." : "No MCP key saved. You can use a manually selected PDF.";
		loaded = true;
		byId("settings-fields").disabled = false;
	} catch (error) { report(error.message, true); }
}

if (globalThis.document && globalThis.chrome) void mountAutofillSettings({ document, chromeApi: chrome });
