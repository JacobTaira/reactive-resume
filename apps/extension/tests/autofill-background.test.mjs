import assert from "node:assert/strict";
import test from "node:test";
import {
	approvedAnswers,
	approvedProfile,
	boundedBytes,
	checkedManualResume,
	checkedPdfUrl,
	createAutofillService,
	trustedAutofillSender,
} from "../src/autofill-background.js";

const sender = { id: "fixture", url: "chrome-extension://fixture/popup.html" };
const baseUrl = "http://localhost:3000";
const manualResume = { base64: btoa("%PDF-1.7\nfictional test document"), fileName: "Example Engineer.pdf", mimeType: "application/pdf" };
function fixture({ configured = true } = {}) {
	const storage = {
		config: { baseUrl, apiKey: "capture-only-fictional" },
		autofillConfig: configured ? { baseUrl, apiKey: "normal-fictional" } : null,
		autofillProfile: { firstName: "Example", lastName: "Candidate", email: "candidate@example.com" },
		autofillAnswers: [{ question: "When can you start?", answer: "After graduation", applicationId: "app-1" }],
	};
	const tab = { id: 7, url: "https://careers.example.com/apply/123" };
	const calls = [];
	const scripts = [];
	const session = {};
	const application = { id: "app-1", company: "Example", role: "Engineer", resumeId: "resume-1" };
	const chrome = {
		runtime: { id: "fixture" },
		storage: { session: {
			setAccessLevel: async (value) => assert.equal(value.accessLevel, "TRUSTED_CONTEXTS"),
			get: async (defaults) => Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, structuredClone(session[key] ?? value)])),
			set: async (value) => Object.assign(session, structuredClone(value)),
		}, local: {
			setAccessLevel: async (value) => assert.equal(value.accessLevel, "TRUSTED_CONTEXTS"),
			get: async (defaults) => Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, storage[key] ?? value])),
			set: async (value) => Object.assign(storage, structuredClone(value)),
		} },
		permissions: { contains: async () => true },
		tabs: { query: async () => [structuredClone(tab)], get: async () => structuredClone(tab) },
		scripting: { executeScript: async (request) => {
			scripts.push(request);
			if (request.files) return [];
			if (request.target.documentIds) return [{ frameId: 0, documentId: "document-1", result: { filled: [{ id: "email", label: "Email" }], failed: [], skipped: [], unsupported: [] } }];
			return [{ frameId: 0, documentId: "document-1", result: { pageUrl: tab.url, fingerprint: "fields-1", fields: [
				{ id: "email", label: "Email", type: "email", status: "matched", value: "candidate@example.com" },
				{ id: "name", label: "Name", type: "text", status: "preserved", reason: "Existing answer preserved" },
			] } }];
		} },
	};
	let downloadUrl = `${baseUrl}/api/resumes/resume-1/pdf?token=fictional`;
	let pdfText = "%PDF-1.7\nfictional test document";
	const fetchImpl = async (url, options) => {
		calls.push({ url, options });
		if (url.endsWith("/mcp")) {
			const request = JSON.parse(options.body);
			let result;
			if (request.params.name === "read_application") result = structuredClone(application);
			else if (request.params.name === "download_resume_pdf") result = { resumeId: "resume-1", name: "Example — Engineer", downloadUrl };
			else if (request.params.name === "list_tailoring_queue") result = { items: [{ ...application, preparation: { draftResumeId: "resume-1" } }], total: 1, nextOffset: null };
			else throw new Error("Unexpected MCP tool");
			return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { structuredContent: result } }), { headers: { "content-type": "application/json" } });
		}
		return new Response(pdfText, { headers: { "content-type": "application/pdf" } });
	};
	const service = createAutofillService(chrome, { fetchImpl });
	return { service, storage, session, tab, calls, scripts, chrome, application, fetchImpl,
		setDownloadUrl: (value) => { downloadUrl = value; }, setPdf: (value) => { pdfText = value; },
		message: (value, from = sender) => service(value, from) };
}

test("autofill commands accept only this extension's exact popup/settings paths", async () => {
	assert.equal(trustedAutofillSender(sender, "fixture"), true);
	assert.equal(trustedAutofillSender({ id: "fixture", url: "chrome-extension://fixture/autofill.html" }, "fixture"), true);
	const subject = fixture();
	for (const from of [
		{ id: "different", url: sender.url },
		{ id: "fixture", url: "https://careers.example.com/popup.html" },
		{ id: "fixture", url: "chrome-extension://fixture/popup.html/other" },
		{ id: "fixture", url: "chrome-extension://fixture/options.html" },
		{ id: "fixture", tab: { id: 7, url: "https://jobright.ai/jobs/info/123" } },
	]) await assert.rejects(subject.message({ type: "autofill-state" }, from), /only from this extension/);
	assert.equal(subject.calls.length, 0);
});

test("state never exposes either API key; capture key does not enable MCP reads", async () => {
	const subject = fixture({ configured: false });
	const state = await subject.message({ type: "autofill-state" });
	assert.equal(state.configured, false);
	assert.equal(JSON.stringify(state).includes("fictional"), false);
	await assert.rejects(subject.message({ type: "autofill-list" }), /normal MCP API key/);
	assert.equal(subject.calls.length, 0);
});

test("approved inputs whitelist profile fields and retain explicit application-scoped answers", () => {
	const profile = approvedProfile({ firstName: " Example ", apiKey: "must not leak", hidden: "no" });
	assert.equal(profile.firstName, "Example");
	assert.equal("apiKey" in profile, false);
	assert.equal("hidden" in profile, false);
	assert.deepEqual(approvedAnswers([{ question: " Start date? ", answer: " Confirmed date ", applicationId: "app-1" }]), [{ question: "Start date?", answer: "Confirmed date", applicationId: "app-1" }]);
	assert.deepEqual(approvedAnswers([{ question: "Email", answer: "reference@example.com", applicationId: "app-1", fieldId: "rr-reference", approved: false }]), [{ question: "Email", answer: "reference@example.com", applicationId: "app-1", fieldId: "rr-reference", approved: false }]);
	assert.throws(() => approvedAnswers([{ question: "Q", answer: "A", applicationId: {} }]), /optional applicationId/);
	assert.throws(() => approvedAnswers([{ question: "Q", answer: "A", approved: "false" }]), /must be true or false/);
	assert.throws(() => approvedAnswers([{ question: "Question" }]), /question and answer/);
	assert.throws(() => approvedAnswers(Array(201).fill({ question: "Q", answer: "A" })), /at most 200/);
});

test("saving autofill settings keeps capture-only configuration intact and never returns a key", async () => {
	const subject = fixture();
	const result = await subject.message({ type: "autofill-save", baseUrl, apiKey: "", profile: { firstName: "Approved" }, answers: [] });
	assert.equal(subject.storage.config.apiKey, "capture-only-fictional");
	assert.equal(subject.storage.autofillConfig.apiKey, "normal-fictional");
	assert.equal(subject.storage.autofillProfile.firstName, "Approved");
	assert.equal("apiKey" in result, false);
	subject.chrome.permissions.contains = async () => false;
	await assert.rejects(subject.message({ type: "autofill-save", baseUrl, apiKey: "replacement", profile: {}, answers: [] }), /Grant access/);
	assert.equal(subject.storage.autofillConfig.apiKey, "normal-fictional");
});

test("signed PDF URLs must match the installation and exact selected resume", () => {
	assert.equal(checkedPdfUrl(`${baseUrl}/api/resumes/resume-1/pdf?token=ok`, baseUrl, "resume-1"), `${baseUrl}/api/resumes/resume-1/pdf?token=ok`);
	for (const url of [
		"https://attacker.example/api/resumes/resume-1/pdf?token=ok",
		`${baseUrl}/api/resumes/other/pdf?token=ok`,
		`${baseUrl}/api/resumes/resume-1/pdf`,
		"http://user:password@localhost:3000/api/resumes/resume-1/pdf?token=ok",
	]) assert.throws(() => checkedPdfUrl(url, baseUrl, "resume-1"), /unexpected PDF address/);
});

test("manual documents and streaming downloads enforce real bytes and size", async () => {
	assert.equal(checkedManualResume(manualResume).fileName, "Example Engineer.pdf");
	assert.throws(() => checkedManualResume({ ...manualResume, base64: btoa("not a PDF") }), /valid PDF/);
	assert.throws(() => checkedManualResume({ ...manualResume, base64: "%%%" }), /could not be read/);
	await assert.rejects(boundedBytes(new Response("x".repeat(100)), 20), /allowed size/);
	await assert.rejects(boundedBytes(new Response("short", { headers: { "content-length": "100" } }), 20), /allowed size/);
});

test("saved-job preview downloads only its linked PDF and injects no keys or signed URLs", async () => {
	const subject = fixture();
	const preview = await subject.message({ type: "autofill-preview", applicationId: "app-1" });
	assert.equal(preview.application.id, "app-1");
	assert.equal(preview.fileName, "Example — Engineer.pdf");
	assert.equal(preview.fields[0].id, "0:email");
	assert.equal(subject.calls.length, 3);
	for (const request of subject.calls.slice(0, 2)) {
		assert.equal(request.options.headers["x-api-key"], "normal-fictional");
		assert.equal(request.options.credentials, "omit");
		assert.equal(request.options.redirect, "error");
	}
	const download = subject.calls[2];
	assert.equal(download.options.headers["x-api-key"], undefined);
	assert.equal(download.options.credentials, "omit");
	assert.equal(download.options.redirect, "error");
	const contentArgs = JSON.stringify(subject.scripts.flatMap((request) => request.args || []));
	assert.equal(contentArgs.includes("normal-fictional"), false);
	assert.equal(contentArgs.includes("capture-only-fictional"), false);
	assert.equal(contentArgs.includes("token="), false);
	assert.equal(JSON.stringify(preview).includes("base64"), false);
});

test("a malicious PDF URL is refused before any download or content injection", async () => {
	const subject = fixture();
	subject.setDownloadUrl("https://attacker.example/resume.pdf");
	await assert.rejects(subject.message({ type: "autofill-preview", applicationId: "app-1" }), /unexpected PDF address/);
	assert.equal(subject.calls.length, 2);
	assert.equal(subject.scripts.length, 0);
});

test("manual PDF mode works without any MCP or Jobright request", async () => {
	const subject = fixture({ configured: false });
	const preview = await subject.message({ type: "autofill-preview", company: "Example", role: "Engineer", manualResume });
	assert.equal(preview.application.company, "Example");
	assert.equal(subject.calls.length, 0);
	await subject.message({ type: "autofill-fill", token: preview.token, fieldIds: ["0:email"] });
	assert.equal(subject.calls.length, 0);
});

test("fills target the previewed document and selected fields, reject replay and preserved fields", async () => {
	const subject = fixture();
	const preview = await subject.message({ type: "autofill-preview", applicationId: "app-1" });
	await assert.rejects(subject.message({ type: "autofill-fill", token: preview.token, fieldIds: ["0:name"] }), /selection does not match/);
	const result = await subject.message({ type: "autofill-fill", token: preview.token, fieldIds: ["0:email"] });
	assert.equal(result.reports[0].filled.length, 1);
	const fill = subject.scripts.at(-1);
	assert.deepEqual(fill.target, { tabId: 7, documentIds: ["document-1"] });
	assert.deepEqual(fill.args[1], { fieldIds: ["email"], expectedUrl: subject.tab.url, expectedFingerprint: "fields-1" });
	await assert.rejects(subject.message({ type: "autofill-fill", token: preview.token, fieldIds: ["0:email"] }), /preview expired/);
});

test("navigation and changed resume linkage invalidate filling before page mutation", async () => {
	const subject = fixture();
	let preview = await subject.message({ type: "autofill-preview", applicationId: "app-1" });
	subject.tab.url = "https://careers.example.com/apply/other";
	await assert.rejects(subject.message({ type: "autofill-fill", token: preview.token, fieldIds: ["0:email"] }), /active tab changed/);
	assert.equal(subject.scripts.length, 2);
	subject.tab.url = "https://careers.example.com/apply/123";
	preview = await subject.message({ type: "autofill-preview", applicationId: "app-1" });
	subject.application.resumeId = "different-resume";
	await assert.rejects(subject.message({ type: "autofill-fill", token: preview.token, fieldIds: ["0:email"] }), /linked resume changed/);
	assert.equal(subject.scripts.length, 4);
});

test("preview survives an MV3 worker restart without storing file bytes or credentials", async () => {
	const subject = fixture();
	const preview = await subject.message({ type: "autofill-preview", applicationId: "app-1" });
	const savedSession = JSON.stringify(subject.session);
	assert.equal(savedSession.includes("base64"), false);
	assert.equal(savedSession.includes("normal-fictional"), false);
	assert.equal(savedSession.includes("token="), false);
	assert.match(subject.session.autofillPreview.pdfDigest, /^[0-9a-f]{64}$/);
	const restarted = createAutofillService(subject.chrome, { fetchImpl: subject.fetchImpl });
	const result = await restarted({ type: "autofill-fill", token: preview.token, fieldIds: ["0:email"] }, sender);
	assert.equal(result.reports[0].filled.length, 1);
	assert.equal(subject.calls.filter((item) => !item.url.endsWith("/mcp")).length, 2);
	assert.equal(subject.scripts.at(-1).args[0].resume.base64, manualResume.base64);
	assert.equal(subject.session.autofillPreview, null);
});

test("a restarted worker refuses a changed PDF before injecting any fill", async () => {
	const subject = fixture();
	const preview = await subject.message({ type: "autofill-preview", applicationId: "app-1" });
	subject.setPdf("%PDF-1.7\nchanged fictional document");
	const restarted = createAutofillService(subject.chrome, { fetchImpl: subject.fetchImpl });
	await assert.rejects(restarted({ type: "autofill-fill", token: preview.token, fieldIds: ["0:email"] }, sender), /PDF changed after preview/);
	assert.equal(subject.scripts.length, 2);
});

test("manual PDF previews survive restart only when the same file is supplied again", async () => {
	const subject = fixture({ configured: false });
	const preview = await subject.message({ type: "autofill-preview", company: "Example", role: "Engineer", manualResume });
	const restarted = createAutofillService(subject.chrome, { fetchImpl: subject.fetchImpl });
	const message = { type: "autofill-fill", token: preview.token, fieldIds: ["0:email"] };
	await assert.rejects(restarted(message, sender), /Select the same manual PDF/);
	await assert.rejects(restarted({ ...message, manualResume: { ...manualResume, base64: btoa("%PDF-1.7\ndifferent file") } }, sender), /PDF changed after preview/);
	assert.equal(subject.scripts.length, 2);
	const result = await restarted({ ...message, manualResume }, sender);
	assert.equal(result.reports[0].filled.length, 1);
	assert.equal(subject.calls.length, 0);
});

test("changed approval scope invalidates a persisted preview and saving clears it", async () => {
	const subject = fixture();
	const preview = await subject.message({ type: "autofill-preview", applicationId: "app-1" });
	subject.storage.autofillAnswers[0].applicationId = "different-app";
	const restarted = createAutofillService(subject.chrome, { fetchImpl: subject.fetchImpl });
	await assert.rejects(restarted({ type: "autofill-fill", token: preview.token, fieldIds: ["0:email"] }, sender), /profile, answers or connection changed/);
	assert.equal(subject.scripts.length, 2);
	await subject.message({ type: "autofill-save", baseUrl, apiKey: "", profile: subject.storage.autofillProfile, answers: subject.storage.autofillAnswers });
	assert.equal(subject.session.autofillPreview, null);
	assert.equal(subject.session.autofillSelection, null);
});

test("last saved-job selection is restored only for its exact tab and URL", async () => {
	const subject = fixture();
	await subject.message({ type: "autofill-preview", applicationId: "app-1" });
	const restarted = createAutofillService(subject.chrome, { fetchImpl: subject.fetchImpl });
	assert.equal((await restarted({ type: "autofill-state" }, sender)).selection.id, "app-1");
	subject.tab.url = "https://careers.example.com/apply/another-requisition";
	assert.equal((await restarted({ type: "autofill-state" }, sender)).selection, null);
	subject.tab.url = "https://careers.example.com/apply/123";
	subject.tab.id = 8;
	assert.equal((await restarted({ type: "autofill-state" }, sender)).selection, null);
});
