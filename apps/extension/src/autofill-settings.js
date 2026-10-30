/* global chrome */
import { normalizedBaseUrl } from "./outbox.js";

const FIELDS = [["firstName", "First name"], ["lastName", "Last name"], ["fullName", "Full name"], ["email", "Email"], ["phone", "Phone"], ["address", "Street address"], ["city", "City"], ["state", "State or region"], ["country", "Country"], ["postalCode", "Postal code"], ["linkedin", "LinkedIn URL"], ["github", "GitHub URL"], ["website", "Website URL"]];
const byId = (id) => document.getElementById(id);
const send = async (message) => {
	const result = await chrome.runtime.sendMessage(message);
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
byId("settings").addEventListener("submit", async (event) => {
	event.preventDefault();
	try {
		const baseUrl = normalizedBaseUrl(byId("base-url").value);
		let answers;
		try { answers = JSON.parse(byId("answers").value || "[]"); } catch { throw new Error("Approved answers must be valid JSON: an array of question and answer objects."); }
		if (!(await chrome.permissions.request({ origins: [`${baseUrl}/*`] }))) throw new Error("Installation access was not granted. Settings were not changed.");
		const profile = Object.fromEntries(FIELDS.map(([key]) => [key, byId(key).value]));
		const result = await send({ type: "autofill-save", baseUrl, apiKey: byId("api-key").value, profile, answers });
		byId("api-key").value = "";
		byId("connection").textContent = result.configured ? "Normal MCP key saved. Capture-only settings remain separate." : "Manual PDF mode. Add a normal MCP key when you want saved-job selection.";
		report(result.message);
	} catch (error) { report(error.message, true); }
});
void send({ type: "autofill-state" }).then((state) => {
	byId("base-url").value = state.baseUrl;
	for (const [key] of FIELDS) byId(key).value = state.profile[key] || "";
	byId("answers").value = JSON.stringify(state.answers, null, 2);
	byId("connection").textContent = state.configured ? "Normal MCP key saved. Leave the key blank to keep it." : "No MCP key saved. You can use a manually selected PDF.";
}).catch((error) => report(error.message, true));
