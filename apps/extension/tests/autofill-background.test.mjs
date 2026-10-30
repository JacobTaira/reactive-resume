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
// Storage may reorder dictionary keys. Preserve array order and values while
// exercising that round-trip instead of structuredClone's insertion order.
function storageClone(value) {
	if (Array.isArray(value)) return value.map(storageClone);
	if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, storageClone(value[key])]));
	return value;
}
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
			get: async (defaults) => Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, storageClone(session[key] ?? value)])),
			set: async (value) => Object.assign(session, storageClone(value)),
		}, local: {
			setAccessLevel: async (value) => assert.equal(value.accessLevel, "TRUSTED_CONTEXTS"),
			get: async (defaults) => Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, storageClone(storage[key] ?? value)])),
			set: async (value) => Object.assign(storage, storageClone(value)),
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

test("settings state can load without an employer tab and never enables form actions on extension pages", async () => {
	const subject = fixture({ configured: false });
	subject.chrome.tabs.query = async () => [];
	const state = await subject.message({ type: "autofill-state" }, { ...sender, url: "chrome-extension://fixture/autofill.html" });
	assert.equal(state.configured, false);
	assert.equal(state.draftContext.tabId, undefined);
	await assert.rejects(subject.message({ type: "autofill-preview", manualResume }), /ordinary browser tab/u);
	assert.equal(subject.scripts.length, 0);
});

test("detached preview, fill, diagnostics, capture and clearing stay bound after focus changes and worker restart", async () => {
	const subject = fixture({ configured: false });
	await subject.message({ type: "autofill-state" });
	const source = { ...subject.tab, windowId: 1 };
	const other = { id: 8, windowId: 2, url: "https://other-employer.example/apply" };
	let active = source;
	let windowTab;
	const captured = [];
	subject.chrome.runtime.getURL = (path) => `chrome-extension://fixture/${path}`;
	subject.chrome.tabs.query = async () => [structuredClone(active)];
	subject.chrome.tabs.get = async (id) => {
		if (id === 7) return structuredClone(source);
		if (id === 101 && windowTab) return structuredClone(windowTab);
		throw new Error("No such tab");
	};
	subject.chrome.windows = {
		create: async ({ url }) => {
			windowTab = { id: 101, windowId: 10, url }; active = windowTab;
			return { id: 10, tabs: [windowTab] };
		},
		update: async (id) => ({ id }),
	};
	let service = createAutofillService(subject.chrome, { fetchImpl: subject.fetchImpl, captureTab: async (tab) => captured.push(tab.id) });
	await service({ type: "autofill-open-window", tabId: 7, tabUrl: source.url }, sender);
	const from = { ...sender, url: windowTab.url, tab: { id: 101 } };
	active = other;
	const state = await service({ type: "autofill-state" }, from);
	assert.equal(state.windowMode, true);
	assert.equal(state.draftContext.tabId, 7);
	assert.equal(state.draftContext.tabUrl, source.url);
	const expected = { expectedTabId: 7, expectedTabUrl: source.url };
	const preview = await service({ type: "autofill-preview", manualResume, ...expected }, from);
	assert.equal(preview.tabUrl, source.url);
	service = createAutofillService(subject.chrome, { fetchImpl: subject.fetchImpl, captureTab: async (tab) => captured.push(tab.id) });
	const result = await service({ type: "autofill-fill", token: preview.token, fieldIds: ["0:email"], manualResume, ...expected }, from);
	assert.equal(result.reports[0].filled.length, 1);
	await service({ type: "autofill-diagnostics", ...expected }, from);
	await service({ type: "autofill-capture", ...expected }, from);
	await service({ type: "autofill-clear-draft", ...expected }, from);
	assert.deepEqual(captured, [7]);
	assert.ok(subject.scripts.length > 0);
	assert.ok(subject.scripts.every((request) => request.target.tabId === 7));
});

test("same-tab navigation refuses a detached window's old preview before any fill", async () => {
	const subject = fixture({ configured: false });
	await subject.message({ type: "autofill-state" });
	const token = "fictional-window-context";
	subject.session.autofillApplicationWindows = { [token]: { sourceTabId: 7, sourceOrigin: new URL(subject.tab.url).origin, sourceUrl: subject.tab.url, extensionTabId: 101, windowId: 10 } };
	const from = { ...sender, url: `chrome-extension://fixture/popup.html?mode=window&context=${token}`, tab: { id: 101 } };
	const expected = { expectedTabId: 7, expectedTabUrl: subject.tab.url };
	const preview = await subject.message({ type: "autofill-preview", manualResume, ...expected }, from);
	subject.tab.url += "/next";
	const before = subject.scripts.length;
	await assert.rejects(subject.message({ type: "autofill-fill", token: preview.token, fieldIds: ["0:email"], manualResume, ...expected }, from), /page changed/u);
	await assert.rejects(subject.message({ type: "autofill-preview", manualResume, ...expected }, from), /page changed/u);
	assert.equal(subject.scripts.length, before);
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

test("popup draft context survives worker suspension and exposes only the current page's live preview token", async () => {
	const subject = fixture();
	const initial = await subject.message({ type: "autofill-state" });
	assert.deepEqual(initial.draftContext, { sessionId: subject.session.autofillDraftSessionId, tabId: 7, tabUrl: subject.tab.url });
	assert.equal(initial.previewToken, null);
	const preview = await subject.message({ type: "autofill-preview", company: "Example", role: "Engineer", manualResume });
	const restarted = createAutofillService(subject.chrome, { fetchImpl: subject.fetchImpl });
	let state = await restarted({ type: "autofill-state" }, sender);
	assert.equal(state.draftContext.sessionId, initial.draftContext.sessionId);
	assert.equal(state.previewToken, preview.token);
	subject.tab.id = 8;
	assert.equal((await restarted({ type: "autofill-state" }, sender)).previewToken, null);
	subject.tab.id = 7;
	subject.session.autofillPreview.createdAt = Date.now() - 11 * 60 * 1000;
	state = await restarted({ type: "autofill-state" }, sender);
	assert.equal(state.previewToken, null);
});

test("clearing a draft invalidates its worker selection and preview without touching another tab", async () => {
	const subject = fixture();
	const preview = await subject.message({ type: "autofill-preview", applicationId: "app-1" });
	subject.tab.id = 8;
	await subject.message({ type: "autofill-clear-draft" });
	assert.equal(subject.session.autofillPreview.token, preview.token);
	subject.tab.id = 7;
	await subject.message({ type: "autofill-clear-draft" });
	assert.equal(subject.session.autofillPreview, null);
	assert.equal(subject.session.autofillSelection, null);
	await assert.rejects(subject.message({ type: "autofill-fill", token: preview.token, fieldIds: ["0:email"] }), /preview expired/);
});

for (const configured of [false, true]) for (const restart of [false, true]) {
	test(`unchanged ${configured ? "saved-job" : "manual"} approvals survive reordered storage${restart ? " and a worker restart" : ""}`, async () => {
		const subject = fixture({ configured });
		subject.storage.autofillAnswers = [{ question: "When can you start?", answer: "After graduation", applicationId: "app-1", fieldId: "start-date", approved: true }];
		const preview = await subject.message({ type: "autofill-preview", ...(configured ? { applicationId: "app-1" } : { company: "Example", role: "Engineer", manualResume }) });
		const stored = subject.session.autofillPreview.packet;
		assert.notEqual(JSON.stringify(stored.profile), JSON.stringify(approvedProfile(subject.storage.autofillProfile)));
		assert.notEqual(JSON.stringify(stored.answers), JSON.stringify(approvedAnswers(subject.storage.autofillAnswers)));
		const service = restart ? createAutofillService(subject.chrome, { fetchImpl: subject.fetchImpl }) : subject.service;
		const result = await service({ type: "autofill-fill", token: preview.token, fieldIds: ["0:email"], ...(!configured ? { manualResume } : {}) }, sender);
		assert.equal(result.reports[0].filled.length, 1);
		assert.equal(subject.session.autofillPreview, null);
	});
}

test("real profile, answer, approval scope and connection changes still block before any fill", async () => {
	const changes = [
		(storage) => { storage.autofillProfile.email = "changed@example.test"; },
		(storage) => { storage.autofillAnswers[0].answer = "A different answer"; },
		(storage) => { storage.autofillAnswers[0].question = "A different question?"; },
		(storage) => { storage.autofillAnswers[0].applicationId = "different-app"; },
		(storage) => { storage.autofillAnswers[0].fieldId = "different-field"; },
		(storage) => { storage.autofillAnswers[0].approved = false; },
		(storage) => { storage.autofillConfig.baseUrl = "https://another-installation.example.test"; },
	];
	for (const change of changes) {
		const subject = fixture();
		const preview = await subject.message({ type: "autofill-preview", applicationId: "app-1" });
		change(subject.storage);
		await assert.rejects(subject.message({ type: "autofill-fill", token: preview.token, fieldIds: ["0:email"] }), /profile, answers or connection changed/);
		assert.equal(subject.scripts.length, 2);
	}
});

test("common answers round-trip separately and old settings clients preserve them", async () => {
	const subject = fixture();
	const commonAnswers = { jobSource: "Personal search", priorGovernmentEmployment: "No", gender: "Decline to self-identify", race: "", protectedVeteranStatus: "I am not a protected veteran" };
	await subject.message({ type: "autofill-save", baseUrl, profile: subject.storage.autofillProfile, answers: subject.storage.autofillAnswers, commonAnswers });
	let state = await subject.message({ type: "autofill-state" });
	assert.deepEqual(state.commonAnswers, commonAnswers);
	assert.equal(state.answers[0].applicationId, "app-1");
	await subject.message({ type: "autofill-save", baseUrl, profile: subject.storage.autofillProfile, answers: subject.storage.autofillAnswers });
	state = await subject.message({ type: "autofill-state" });
	assert.deepEqual(state.commonAnswers, commonAnswers);
	await subject.message({ type: "autofill-save", baseUrl, profile: subject.storage.autofillProfile, answers: subject.storage.autofillAnswers, commonAnswers: {} });
	assert.ok(Object.values((await subject.message({ type: "autofill-state" })).commonAnswers).every((value) => value === ""));
});

test("approved common answers reach preview and unchanged reordered snapshots still fill", async () => {
	const subject = fixture({ configured: false });
	subject.storage.autofillCommonAnswers = { jobSource: "Personal search", priorGovernmentEmployment: "No", gender: "Decline to self-identify" };
	const preview = await subject.message({ type: "autofill-preview", company: "Example", role: "Engineer", manualResume });
	const packet = subject.scripts.at(-1).args[0];
	assert.equal(packet.commonAnswers.jobSource, "Personal search");
	assert.equal(packet.commonAnswers.gender, "Decline to self-identify");
	assert.equal(packet.commonAnswers.race, "");
	const restarted = createAutofillService(subject.chrome, { fetchImpl: subject.fetchImpl });
	const result = await restarted({ type: "autofill-fill", token: preview.token, fieldIds: ["0:email"], manualResume }, sender);
	assert.equal(result.reports[0].filled.length, 1);
});

test("changing or withdrawing a common answer invalidates the reviewed snapshot", async () => {
	for (const changed of ["Female", ""]) {
		const subject = fixture({ configured: false });
		subject.storage.autofillCommonAnswers = { gender: "Male" };
		const preview = await subject.message({ type: "autofill-preview", manualResume });
		subject.storage.autofillCommonAnswers.gender = changed;
		await assert.rejects(subject.message({ type: "autofill-fill", token: preview.token, fieldIds: ["0:email"], manualResume }), /profile, answers or connection changed/);
		assert.equal(subject.scripts.length, 2);
	}
});

const manualCoverLetter = { base64: btoa("%PDF-1.7\nfictional cover letter"), fileName: "Example-Cover-Letter.pdf", mimeType: "application/pdf" };
test("cover letters are separately selected, previewed and digest-bound without persisting bytes in session", async () => {
	const subject = fixture({ configured: false });
	const preview = await subject.message({ type: "autofill-preview", company: "Example", role: "Engineer", manualResume, manualCoverLetter });
	assert.equal(preview.coverLetterName, manualCoverLetter.fileName);
	assert.equal(subject.scripts.at(-1).args[0].coverLetter.base64, manualCoverLetter.base64);
	const stored = JSON.stringify(subject.session);
	assert.equal(stored.includes("base64"), false);
	assert.equal(stored.includes(manualCoverLetter.base64), false);
	assert.match(subject.session.autofillPreview.coverLetterDigest, /^[0-9a-f]{64}$/);
	const restarted = createAutofillService(subject.chrome, { fetchImpl: subject.fetchImpl });
	const message = { type: "autofill-fill", token: preview.token, fieldIds: ["0:email"], manualResume };
	await assert.rejects(restarted(message, sender), /same cover-letter PDF/);
	await assert.rejects(restarted({ ...message, manualCoverLetter: { ...manualCoverLetter, base64: btoa("%PDF-1.7\nwrong cover letter") } }, sender), /cover-letter PDF changed/);
	assert.equal(subject.scripts.length, 2);
	await restarted({ ...message, manualCoverLetter }, sender);
	const packet = subject.scripts.at(-1).args[0];
	assert.equal(packet.resume.base64, manualResume.base64);
	assert.equal(packet.coverLetter.base64, manualCoverLetter.base64);
	assert.equal(subject.calls.length, 0);
});

test("an unreviewed cover letter cannot be added while filling", async () => {
	const subject = fixture({ configured: false });
	const preview = await subject.message({ type: "autofill-preview", manualResume });
	await assert.rejects(subject.message({ type: "autofill-fill", token: preview.token, fieldIds: ["0:email"], manualResume, manualCoverLetter }), /cover letter changed after preview/);
	assert.equal(subject.scripts.length, 2);
});

test("trusted diagnostics require no resume or MCP connection and export only saved common answer kinds", async () => {
	const subject = fixture({ configured: false });
	subject.storage.autofillCommonAnswers = { priorGovernmentEmployment: "No", gender: "Decline to self-identify" };
	subject.chrome.runtime.getManifest = () => ({ version: "0.3.1" });
	subject.chrome.scripting.executeScript = async (request) => {
		subject.scripts.push(request);
		if (request.files) return [];
		return [{ frameId: 0, documentId: "document-1", result: { origin: "https://careers.example.com", questions: [], truncated: false } }];
	};
	const result = await subject.message({ type: "autofill-diagnostics" });
	assert.equal(result.schemaVersion, 1);
	assert.equal(result.extensionVersion, "0.3.1");
	assert.deepEqual(result.savedCommonAnswerKinds, ["priorGovernmentEmployment", "gender"]);
	assert.equal(result.frames[0].origin, "https://careers.example.com");
	assert.deepEqual(subject.scripts[0].files, ["src/autofill-diagnostics.js"]);
	assert.equal(subject.scripts[1].args, undefined);
	assert.equal(subject.calls.length, 0);
	assert.equal(subject.session.autofillPreview, undefined);
	for (const secret of ["candidate@example.com", "normal-fictional", "capture-only-fictional", "Decline to self-identify"]) assert.equal(JSON.stringify(result).includes(secret), false);
	await assert.rejects(subject.message({ type: "autofill-diagnostics" }, { id: "fixture", url: "https://careers.example.com/popup.html" }), /only from this extension/);
});

test("diagnostics refuse a tab that navigates during structure collection", async () => {
	const subject = fixture({ configured: false });
	subject.chrome.scripting.executeScript = async (request) => {
		if (request.files) return [];
		subject.tab.url = "https://another-employer.example.test";
		return [{ result: { origin: "https://careers.example.com", questions: [] } }];
	};
	await assert.rejects(subject.message({ type: "autofill-diagnostics" }), /tab navigated/);
	assert.equal(subject.calls.length, 0);
});
