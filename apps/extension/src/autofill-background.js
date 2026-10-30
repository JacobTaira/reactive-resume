import { normalizedBaseUrl } from "./outbox.js";

const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const PROFILE_FIELDS = ["firstName", "lastName", "fullName", "email", "phone", "address", "city", "state", "country", "postalCode", "linkedin", "github", "website"];
const PAGE_PATHS = new Set(["/popup.html", "/autofill.html"]);

export function trustedAutofillSender(sender, extensionId) {
	if (sender.id !== extensionId || typeof sender.url !== "string") return false;
	try {
		const url = new URL(sender.url);
		return url.protocol === "chrome-extension:" && url.host === extensionId && PAGE_PATHS.has(url.pathname);
	} catch { return false; }
}

function cleanText(value, maximum = 500) {
	return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

export function approvedProfile(input = {}) {
	return Object.fromEntries(PROFILE_FIELDS.map((key) => [key, cleanText(input[key])]));
}

export function approvedAnswers(input = []) {
	if (!Array.isArray(input) || input.length > 200) throw new Error("Use at most 200 approved answers.");
	return input.map((item) => {
		if (!item || typeof item.question !== "string" || typeof item.answer !== "string" || !item.question.trim() || !item.answer.trim()) {
			throw new Error("Each approved answer needs a question and answer.");
		}
		for (const key of ["applicationId", "fieldId"]) {
			if (item[key] !== undefined && (typeof item[key] !== "string" || !item[key].trim() || item[key].length > 300)) {
				throw new Error(`An optional ${key} must be a nonempty string of at most 300 characters.`);
			}
		}
		if (item.approved !== undefined && typeof item.approved !== "boolean") throw new Error("The optional approved field must be true or false.");
		return { question: cleanText(item.question, 2000), answer: cleanText(item.answer, 10000),
			...(item.applicationId !== undefined ? { applicationId: item.applicationId.trim() } : {}),
			...(item.fieldId !== undefined ? { fieldId: item.fieldId.trim() } : {}),
			...(item.approved !== undefined ? { approved: item.approved } : {}) };
	});
}

export async function boundedBytes(response, limit) {
	const declared = Number(response.headers.get("content-length") || 0);
	if (declared > limit) throw new Error("The response exceeds the allowed size.");
	if (!response.body?.getReader) {
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.length > limit) throw new Error("The response exceeds the allowed size.");
		return bytes;
	}
	const reader = response.body.getReader();
	const chunks = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > limit) throw new Error("The response exceeds the allowed size.");
			chunks.push(value);
		}
	} finally { await reader.cancel(); }
	const result = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
	return result;
}

function pdfBase64(bytes) {
	if (!bytes.length || bytes.length > MAX_PDF_BYTES || new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") {
		throw new Error("Choose a valid PDF no larger than 10 MB.");
	}
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
	return btoa(binary);
}

async function pdfDigest(resume) {
	const bytes = Uint8Array.from(atob(resume.base64), (character) => character.charCodeAt(0));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export function checkedManualResume(value) {
	if (!value?.base64) return null;
	if (typeof value.base64 !== "string" || value.base64.length > Math.ceil(MAX_PDF_BYTES / 3) * 4 + 4) throw new Error("Choose a PDF no larger than 10 MB.");
	let binary;
	try { binary = atob(value.base64); } catch { throw new Error("The selected PDF could not be read."); }
	const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
	return { base64: pdfBase64(bytes), fileName: safePdfName(value.fileName || "resume.pdf"), mimeType: "application/pdf" };
}

function safePdfName(value) {
	const name = cleanText(value, 160).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/\.pdf$/i, "");
	return `${name || "resume"}.pdf`;
}

export function checkedPdfUrl(downloadUrl, baseUrl, resumeId) {
	const url = new URL(downloadUrl);
	if (url.origin !== normalizedBaseUrl(baseUrl) || url.username || url.password || url.hash
		|| url.pathname !== `/api/resumes/${encodeURIComponent(resumeId)}/pdf` || !url.searchParams.get("token")) {
		throw new Error("The installation returned an unexpected PDF address. Check its APP_URL setting.");
	}
	return url.href;
}

export function createAutofillService(chromeApi, { captureTab, fetchImpl = globalThis.fetch } = {}) {
	const previews = new Map();
	const filling = new Set();
	const ready = Promise.all([
		chromeApi.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
		chromeApi.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
	]);
	async function state() {
		await ready;
		return chromeApi.storage.local.get({ autofillConfig: null, autofillProfile: {}, autofillAnswers: [], config: null });
	}
	async function callTool(name, args, suppliedConfig) {
		const config = suppliedConfig || (await state()).autofillConfig;
		if (!config?.apiKey || !config?.baseUrl) throw new Error("Open Autofill settings and add a normal MCP API key, or choose a PDF manually.");
		const baseUrl = normalizedBaseUrl(config.baseUrl);
		const response = await fetchImpl(`${baseUrl}/mcp`, {
			method: "POST", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(90000),
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-03-26", "x-api-key": config.apiKey },
			body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call", params: { name, arguments: args } }),
		});
		if (!response.ok) throw new Error(`The MCP connection failed (${response.status}). Check the normal API key and installation URL.`);
		let envelope;
		try { envelope = JSON.parse(new TextDecoder().decode(await boundedBytes(response, MAX_JSON_BYTES))); }
		catch { throw new Error("The MCP server returned an unreadable response."); }
		if (envelope.error || envelope.result?.isError) throw new Error("The server could not complete this read. Check the selected application and MCP key in your installation.");
		const result = envelope.result;
		if (result?.structuredContent) return result.structuredContent;
		const content = result?.content?.find((item) => item.type === "text")?.text;
		try { return JSON.parse(content); } catch { throw new Error("The MCP server did not return the expected saved record."); }
	}
	async function activeTab() {
		const [tab] = await chromeApi.tabs.query({ active: true, currentWindow: true });
		if (!tab?.id || !/^https?:\/\//.test(tab.url || "")) throw new Error("Open the employer’s application form in an ordinary browser tab.");
		return tab;
	}
	async function linkedResume(application, saved) {
		const resumeId = application.resumeId;
		if (!resumeId) throw new Error("This application has no linked resume. Link its tailored resume or choose a PDF manually.");
		const download = await callTool("download_resume_pdf", { id: resumeId });
		if (download.resumeId !== resumeId) throw new Error("The server returned a different resume. Reopen the intended application.");
		const pdfUrl = checkedPdfUrl(download.downloadUrl, saved.autofillConfig.baseUrl, resumeId);
		// The signed URL authorizes this exact PDF. Never send API keys, cookies or redirects to a download URL.
		const response = await fetchImpl(pdfUrl, { credentials: "omit", redirect: "error", signal: AbortSignal.timeout(90000), headers: { accept: "application/pdf" } });
		if (!response.ok) throw new Error(`The linked PDF could not be downloaded (${response.status}).`);
		return { base64: pdfBase64(await boundedBytes(response, MAX_PDF_BYTES)), fileName: safePdfName(`${application.company} — ${application.role}`), mimeType: "application/pdf" };
	}
	async function makePacket(message) {
		const saved = await state();
		const applicationId = cleanText(message.applicationId, 100);
		let application = { id: "", company: cleanText(message.company, 300), role: cleanText(message.role, 300) };
		let resume = checkedManualResume(message.manualResume);
		let resumeId = null;
		if (applicationId) {
			const record = await callTool("read_application", { id: applicationId });
			if (record.id !== applicationId) throw new Error("The server returned a different application. Select the intended job again.");
			application = { id: record.id, company: record.company, role: record.role };
			resumeId = record.resumeId;
			if (!resume) resume = await linkedResume(record, saved);
		}
		if (!resume) throw new Error("Choose the exact PDF for this application, or select a saved job with a linked resume.");
		return { packet: { profile: approvedProfile(saved.autofillProfile), answers: approvedAnswers(saved.autofillAnswers), application, resume }, resumeId, manualResume: Boolean(message.manualResume?.base64), baseUrl: saved.autofillConfig?.baseUrl || null };
	}
	async function preview(message) {
		const tab = await activeTab();
		const { packet, resumeId, manualResume, baseUrl } = await makePacket(message);
		const current = await chromeApi.tabs.get(tab.id);
		if (current.url !== tab.url) throw new Error("The tab navigated while loading the resume. Preview again on the intended form.");
		await chromeApi.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["src/autofill-engine.js"] });
		const results = await chromeApi.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: (value) => globalThis.ReactiveResumeAutofill.plan(document, value), args: [packet] });
		const frames = results.filter((item) => item.result?.fields?.length && item.documentId);
		if (!frames.length) throw new Error("No supported form fields were found. Open an embedded application form directly, then preview again.");
		const token = crypto.randomUUID();
		const item = { token, tabId: tab.id, tabUrl: tab.url, packet, resumeId, manualResume, baseUrl, frames, createdAt: Date.now(), pdfDigest: await pdfDigest(packet.resume) };
		const { base64: _bytes, ...resumeMetadata } = packet.resume;
		// MV3 workers can stop while the popup remains open. Session storage retains the
		// reviewed context and PDF digest, never the large file or a download credential.
		await chromeApi.storage.session.set({
			autofillPreview: { ...item, packet: { ...packet, resume: resumeMetadata } },
			autofillSelection: { tabId: tab.id, tabUrl: tab.url, application: packet.application },
		});
		previews.clear();
		previews.set(token, item);
		return { token, tabUrl: tab.url, application: packet.application, fileName: packet.resume.fileName,
			fields: frames.flatMap((frame) => frame.result.fields.map((field) => ({ ...field, fieldId: field.id, id: `${frame.frameId}:${field.id}`, frameUrl: frame.result.pageUrl }))),
			message: "Review the selected job, PDF and field values. Existing answers are preserved. Filling does not submit an application." };
	}
	async function fill(message) {
		await ready;
		const { autofillPreview: item } = await chromeApi.storage.session.get({ autofillPreview: null });
		if (!item || item.token !== message.token || Date.now() - item.createdAt > 10 * 60 * 1000) throw new Error("This preview expired. Preview the current form again.");
		if (filling.has(message.token)) throw new Error("This preview is already being filled.");
		filling.add(message.token);
		try {
			const saved = await state();
			if (JSON.stringify(approvedProfile(saved.autofillProfile)) !== JSON.stringify(item.packet.profile)
				|| JSON.stringify(approvedAnswers(saved.autofillAnswers)) !== JSON.stringify(item.packet.answers)
				|| (saved.autofillConfig?.baseUrl || null) !== item.baseUrl) {
				throw new Error("Your approved profile, answers or connection changed. Preview again before filling.");
			}
			const tab = await activeTab();
			if (tab.id !== item.tabId || tab.url !== item.tabUrl) throw new Error("The active tab changed. Preview the intended form again.");
			if (!Array.isArray(message.fieldIds) || !message.fieldIds.length) throw new Error("Select at least one matched field.");
			const allowed = new Set(item.frames.flatMap((frame) => frame.result.fields.filter((field) => field.status === "matched").map((field) => `${frame.frameId}:${field.id}`)));
			if (message.fieldIds.some((id) => !allowed.has(id))) throw new Error("The field selection does not match this preview. Preview again.");
			let currentApplication;
			if (item.packet.application.id) {
				currentApplication = await callTool("read_application", { id: item.packet.application.id });
				if (currentApplication.id !== item.packet.application.id || currentApplication.resumeId !== item.resumeId) throw new Error("The linked resume changed after preview. Preview again before filling.");
			}
			let resume = previews.get(message.token)?.packet.resume;
			if (item.manualResume && message.manualResume?.base64) resume = checkedManualResume(message.manualResume);
			if (!resume?.base64) {
				if (item.manualResume) throw new Error("Select the same manual PDF again, then fill from this preview.");
				resume = await linkedResume(currentApplication, saved);
			}
			if (await pdfDigest(resume) !== item.pdfDigest) throw new Error("The PDF changed after preview. Preview the current file again before filling.");
			const packet = { ...item.packet, resume: { ...resume, fileName: item.packet.resume.fileName } };
			const latest = await chromeApi.storage.session.get({ autofillPreview: null });
			if (latest.autofillPreview?.token !== message.token) throw new Error("A newer preview replaced this one. Review the current preview before filling.");
			// Consume before mutation so double clicks cannot replay a fill.
			previews.delete(message.token);
			await chromeApi.storage.session.set({ autofillPreview: null });
			const reports = [];
			for (const frame of item.frames) {
				const prefix = `${frame.frameId}:`;
				const fieldIds = message.fieldIds.filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length));
				if (!fieldIds.length) continue;
				try {
					const result = await chromeApi.scripting.executeScript({
						target: { tabId: item.tabId, documentIds: [frame.documentId] },
						func: (packet, options) => globalThis.ReactiveResumeAutofill.fill(document, packet, options),
						args: [packet, { fieldIds, expectedUrl: frame.result.pageUrl, expectedFingerprint: frame.result.fingerprint }],
					});
					reports.push(...result.map((entry) => entry.result));
				} catch { reports.push({ failed: [{ label: "Changed or inaccessible application frame", reason: "Preview this step again before filling." }], filled: [], skipped: [], unsupported: [] }); }
			}
			return { reports, message: "Review every filled value and confirm the selected PDF finished uploading on the employer’s page. Complete remaining fields and submit yourself. On the next step, preview again." };
		} finally { filling.delete(message.token); }
	}
	return async (message, sender) => {
		if (!trustedAutofillSender(sender, chromeApi.runtime.id)) throw new Error("Autofill is available only from this extension’s popup and settings.");
		if (message.type === "autofill-state") {
			const saved = await state();
			const { autofillSelection } = await chromeApi.storage.session.get({ autofillSelection: null });
			const [tab] = await chromeApi.tabs.query({ active: true, currentWindow: true });
			const selection = tab?.id === autofillSelection?.tabId && tab?.url === autofillSelection?.tabUrl ? autofillSelection.application : null;
			return { baseUrl: saved.autofillConfig?.baseUrl || saved.config?.baseUrl || "http://localhost:3000", configured: Boolean(saved.autofillConfig?.apiKey), profile: approvedProfile(saved.autofillProfile), answers: approvedAnswers(saved.autofillAnswers), selection };
		}
		if (message.type === "autofill-save") {
			const saved = await state();
			const baseUrl = normalizedBaseUrl(message.baseUrl);
			if (!(await chromeApi.permissions.contains({ origins: [`${baseUrl}/*`] }))) throw new Error("Grant access to your installation before saving.");
			const apiKey = cleanText(message.apiKey || (saved.autofillConfig?.baseUrl === baseUrl ? saved.autofillConfig.apiKey : ""), 10000);
			const config = apiKey ? { baseUrl, apiKey } : null;
			await chromeApi.storage.local.set({ autofillConfig: config, autofillProfile: approvedProfile(message.profile), autofillAnswers: approvedAnswers(message.answers) });
			previews.clear();
			await chromeApi.storage.session.set({ autofillPreview: null, autofillSelection: null });
			return { configured: Boolean(config), message: "Approved profile and answers saved in this browser." };
		}
		if (message.type === "autofill-list") {
			const result = await callTool("list_tailoring_queue", { states: ["ready"], limit: 100, offset: Number.isSafeInteger(message.offset) && message.offset >= 0 ? message.offset : 0, includeDescription: false });
			return { items: (result.items || []).map((item) => ({ id: item.id, company: item.company, role: item.role, resumeId: item.preparation?.draftResumeId || null })), nextOffset: result.nextOffset ?? null, total: result.total || 0 };
		}
		if (message.type === "autofill-preview") return preview(message);
		if (message.type === "autofill-fill") return fill(message);
		if (message.type === "autofill-capture") {
			if (!captureTab) throw new Error("Capture is unavailable.");
			await captureTab(await activeTab());
			return { message: "Capture requested. Check Capture settings for server confirmation." };
		}
		throw new Error("Unknown autofill command.");
	};
}
