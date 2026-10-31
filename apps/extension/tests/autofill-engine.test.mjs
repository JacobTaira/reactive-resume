import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const extensionRoot = fileURLToPath(new URL("../", import.meta.url));
const enginePath = path.join(extensionRoot, "src/autofill-engine.js");
const fixture = fs.readFileSync(new URL("./fixtures/autofill.html", import.meta.url), "utf8");
const demoPacket = {
	profile: {
		firstName: "Alex", lastName: "Example", fullName: "Alex Example", email: "alex@example.test",
		phone: "+1 555 010 2000", city: "Austin", state: "Texas", country: "United States", postalCode: "78701",
		address: "123 Fictional Street", linkedin: "https://www.linkedin.com/in/alex-example",
		github: "https://github.com/example", website: "https://example.test",
	},
	application: { id: "application-one", company: "Example Robotics", role: "Engineer" },
	answers: [{ question: "Why do you want to work at this company?", answer: "I am interested in its robotics work.", applicationId: "application-one" }],
};

let chromium;
try {
	({ chromium } = require("playwright"));
} catch {
	const runtimeModules = process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES;
	if (runtimeModules) {
		try { ({ chromium } = require(path.join(runtimeModules, "playwright"))); } catch { /* Report explicit skip below. */ }
	}
}
const executable = process.env.AUTOFILL_BROWSER_EXECUTABLE || chromium?.executablePath();
const browserAvailable = Boolean(chromium && executable && fs.existsSync(executable));
const skipReason = !chromium ? "Playwright is unavailable; install workspace browser-test dependencies."
	: !browserAvailable ? "Chromium is unavailable; install Playwright Chromium or set AUTOFILL_BROWSER_EXECUTABLE."
		: false;

async function withPage(run) {
	const browser = await chromium.launch({ executablePath: executable, headless: true, args: ["--no-sandbox"] });
	try {
		const page = await browser.newPage();
		await page.setContent(fixture);
		await page.addScriptTag({ path: enginePath });
		await run(page);
	} finally {
		await browser.close();
	}
}

async function mountObservedAshbyShapes(page) {
	await page.evaluate(() => {
		const content = document.querySelector("#captured-ashby-shapes").content.cloneNode(true);
		document.body.replaceChildren(content);
		const container = document.querySelector('[class*="_yesno_"]');
		const backing = container.querySelector('input[type="checkbox"]');
		for (const button of container.querySelectorAll("button")) button.addEventListener("click", () => {
			backing.checked = true;
			backing.value = button.textContent.trim();
			for (const option of container.querySelectorAll("button")) option.classList.toggle("_active_fixture", option === button);
			backing.dispatchEvent(new Event("change", { bubbles: true }));
		});
	});
}

test("observed no-form Ashby button and no-legend fieldsets fill approved answers with native readback", { skip: skipReason }, async () => {
	await withPage(async (page) => {
		await mountObservedAshbyShapes(page);
		const packet = { ...demoPacket, commonAnswers: { priorGovernmentEmployment: "No", gender: "Male", race: "Asian (Not Hispanic or Latino)", protectedVeteranStatus: "I am not a protected veteran" } };
		const plan = await page.evaluate((value) => globalThis.ReactiveResumeAutofill.plan(document, value), packet);
		assert.deepEqual(plan.fields.map((field) => field.label), ["Prior Government Employment?", "Gender", "Race", "Veteran Status"]);
		const result = await page.evaluate((value) => globalThis.ReactiveResumeAutofill.fill(document, value), packet);
		assert.equal(result.filled.length, 4);
		const state = await page.evaluate(() => ({ forms: document.forms.length, buttonType: document.querySelector("#captured-government-no").type,
			buttonForm: document.querySelector("#captured-government-no").form, active: document.querySelector("#captured-government-no").classList.contains("_active_fixture"),
			backing: document.querySelector('[name="prior-government"]').checked, backingValue: document.querySelector('[name="prior-government"]').value,
			gender: document.querySelector("#captured-gender-male").checked, race: document.querySelector("#captured-race-asian").checked, veteran: document.querySelector("#captured-veteran-no").checked,
			submits: window.fixtureSubmits }));
		assert.deepEqual(state, { forms: 0, buttonType: "submit", buttonForm: null, active: true, backing: true, backingValue: "No", gender: true, race: true, veteran: true, submits: 0 });
	});
});

test("observed Ashby choices preserve existing selections and refuse newly associated submit buttons", { skip: skipReason }, async () => {
	await withPage(async (page) => {
		await mountObservedAshbyShapes(page);
		await page.locator("#captured-government-yes").click();
		await page.locator("#captured-gender-female").check();
		const packet = { ...demoPacket, commonAnswers: { priorGovernmentEmployment: "No", gender: "Male" } };
		await page.evaluate((value) => globalThis.ReactiveResumeAutofill.fill(document, value), packet);
		assert.equal(await page.locator("#captured-gender-female").isChecked(), true);
		assert.equal(await page.locator('[name="prior-government"]').inputValue(), "Yes");
		await page.evaluate(() => {
			for (const button of document.querySelectorAll('[class*="_yesno_"] button')) button.classList.remove("_active_fixture");
			document.querySelector('[name="prior-government"]').checked = false;
			const form = document.createElement("form"); form.id = "late-native-form";
			form.addEventListener("submit", (event) => { event.preventDefault(); window.fixtureSubmits++; }); document.body.append(form);
			document.querySelector("#captured-government-no").setAttribute("form", form.id);
		});
		const result = await page.evaluate((value) => globalThis.ReactiveResumeAutofill.fill(document, value), packet);
		assert.equal(result.filled.length, 0);
		assert.equal(await page.evaluate(() => window.fixtureSubmits), 0);
		assert.equal(await page.locator('[name="prior-government"]').isChecked(), false);
	});
});

test("autofill scan is serializable and field IDs remain stable across scans", { skip: skipReason }, async () => {
	await withPage(async (page) => {
		const result = await page.evaluate(() => {
			const first = globalThis.ReactiveResumeAutofill.scan(document);
			const second = globalThis.ReactiveResumeAutofill.scan(document);
			return { first: JSON.parse(JSON.stringify(first)), second };
		});
		assert.ok(Array.isArray(result.first));
		assert.deepEqual(result.first.map((field) => field.id), result.second.map((field) => field.id));
		assert.equal(new Set(result.first.map((field) => field.id)).size, result.first.length);
		assert.ok(result.first.some((field) => /email/i.test(field.label)));
	});
});

test("fills profile fields through observable form events while preserving edits and submission control", { skip: skipReason }, async () => {
	await withPage(async (page) => {
		await page.evaluate((packet) => globalThis.ReactiveResumeAutofill.fill(document, packet), demoPacket);
		const state = await page.evaluate(() => ({
			first: document.querySelector("#first").value,
			last: document.querySelector("#last").value,
			email: document.querySelector("#email").value,
			state: document.querySelector("#state").value,
			country: document.querySelector("#country").value,
			linkedin: document.querySelector("#linkedin").value,
			github: document.querySelector("#github").value,
			preserved: document.querySelector("#preserved").value,
			company: document.querySelector("#company").value,
			referenceEmail: document.querySelector("#reference-email").value,
			emergencyPhone: document.querySelector("#emergency-phone").value,
			employerCity: document.querySelector("#employer-city").value,
			password: document.querySelector("#password").value,
			consent: document.querySelector("#consent").checked,
			unapproved: document.querySelector("#unapproved").value,
			gender: [...document.querySelectorAll('[name="gender"]')].some((input) => input.checked),
			events: window.fixtureEvents, submits: window.fixtureSubmits, next: window.fixtureNext,
			shadowEmail: document.querySelector("#shadow-host").shadowRoot.querySelector("input").value,
		}));
		assert.equal(state.first, "Alex");
		assert.equal(state.last, "Example");
		assert.equal(state.email, demoPacket.profile.email);
		assert.equal(state.state, "TX");
		assert.equal(state.country, "US");
		assert.equal(state.linkedin, demoPacket.profile.linkedin);
		assert.equal(state.github, demoPacket.profile.github);
		assert.equal(state.preserved, "Already edited");
		assert.equal(state.company, "");
		assert.equal(state.referenceEmail, "");
		assert.equal(state.emergencyPhone, "");
		assert.equal(state.employerCity, "");
		assert.equal(state.password, "");
		assert.equal(state.consent, false);
		assert.equal(state.gender, false);
		assert.equal(state.unapproved, "");
		assert.equal(state.shadowEmail, demoPacket.profile.email);
		assert.ok(state.events.some((event) => event.type === "input" && event.value === "Alex"));
		assert.ok(state.events.some((event) => event.type === "change" && event.value === "Alex"));
		assert.equal(state.submits, 0);
		assert.equal(state.next, 0);
	});
});

test("approved answers match exact questions and application scope", { skip: skipReason }, async () => {
	await withPage(async (page) => {
		const packet = structuredClone(demoPacket);
		packet.answers = [
			{ question: "Why do you want to work at this company?", answer: "Wrong employer.", applicationId: "application-two" },
			{ question: "How many years of management experience?", answer: "99", applicationId: "application-one" },
			{ question: "Will you require visa sponsorship?", answer: "No", applicationId: "application-one" },
		];
		await page.evaluate((value) => globalThis.ReactiveResumeAutofill.fill(document, value), packet);
		assert.equal(await page.locator("#reason").inputValue(), "");
		assert.equal(await page.locator("#unapproved").inputValue(), "");
		assert.equal(await page.locator("#visa-no").isChecked(), true);
		assert.equal(await page.locator("#visa-yes").isChecked(), false);
	});
});

test("selective filling changes only fields explicitly selected in preview", { skip: skipReason }, async () => {
	await withPage(async (page) => {
		const plan = await page.evaluate((packet) => globalThis.ReactiveResumeAutofill.plan(document, packet), demoPacket);
		const email = plan.fields.find((field) => /email address/i.test(field.label));
		assert.ok(email);
		await page.evaluate(({ packet, id }) => globalThis.ReactiveResumeAutofill.fill(document, packet, { fieldIds: [id] }), { packet: demoPacket, id: email.id });
		assert.equal(await page.locator("#email").inputValue(), demoPacket.profile.email);
		assert.equal(await page.locator("#first").inputValue(), "");
	});
});

test("stale page or form fingerprint refuses filling before changing controls", { skip: skipReason }, async () => {
	await withPage(async (page) => {
		const result = await page.evaluate(async (packet) => {
			const plan = globalThis.ReactiveResumeAutofill.plan(document, packet);
			const attempts = [];
			for (const options of [
				{ expectedUrl: "https://different-employer.example.test/apply", expectedFingerprint: plan.fingerprint },
				{ expectedUrl: plan.pageUrl, expectedFingerprint: "invalid-old-fingerprint" },
			]) {
				try { attempts.push(await globalThis.ReactiveResumeAutofill.fill(document, packet, options)); }
				catch (error) { attempts.push({ error: error.message }); }
			}
			return { attempts, first: document.querySelector("#first").value };
		}, demoPacket);
		assert.equal(result.first, "");
		assert.ok(result.attempts.every((attempt) => /stale|changed|different|fingerprint|page|preview/i.test(JSON.stringify(attempt))));
	});
});

test("resume upload uses exact selected PDF and never populates cover-letter attachment", { skip: skipReason }, async () => {
	await withPage(async (page) => {
		const packet = { ...demoPacket, resume: { base64: Buffer.from("%PDF-1.4\nFictional test PDF\n").toString("base64"), fileName: "Example-Robotics-Engineer.pdf", mimeType: "application/pdf" } };
		const result = await page.evaluate((value) => globalThis.ReactiveResumeAutofill.fill(document, value), packet);
		const state = await page.evaluate(async () => ({
			resume: [...document.querySelector("#resume").files].map((file) => ({ name: file.name, type: file.type })),
			text: await document.querySelector("#resume").files[0]?.text(),
			coverCount: document.querySelector("#cover").files.length,
		}));
		assert.deepEqual(state.resume, [{ name: packet.resume.fileName, type: "application/pdf" }]);
		assert.equal(state.text, "%PDF-1.4\nFictional test PDF\n");
		assert.equal(state.coverCount, 0);
		assert.ok(JSON.stringify(result).match(/selected|verify|upload/i));
	});
});

test("invalid file signature cannot be uploaded as a resume", { skip: skipReason }, async () => {
	await withPage(async (page) => {
		const packet = { ...demoPacket, resume: { base64: Buffer.from("not a PDF").toString("base64"), fileName: "resume.pdf", mimeType: "application/pdf" } };
		try { await page.evaluate((value) => globalThis.ReactiveResumeAutofill.fill(document, value), packet); } catch { /* Rejecting the packet is valid too. */ }
		assert.equal(await page.locator("#resume").evaluate((input) => input.files.length), 0);
	});
});

test("unsupported custom dropdown remains unchanged and is reported", { skip: skipReason }, async () => {
	await withPage(async (page) => {
		const packet = { ...demoPacket, answers: [{ question: "Favorite framework", answer: "React" }] };
		const result = await page.evaluate((value) => globalThis.ReactiveResumeAutofill.fill(document, value), packet);
		assert.equal(await page.locator("#unsupported-combo").textContent(), "");
		assert.ok(JSON.stringify(result).match(/unsupported|option|unmatched|manual/i));
	});
});

test("choice controls update click-driven application state without submitting", { skip: skipReason }, async () => {
	await withPage(async (page) => {
		const packet = { ...demoPacket, answers: [
			{ question: "Will you require visa sponsorship?", answer: "No" },
			{ question: "I agree to the terms and consent to data processing", answer: "Yes" },
		] };
		await page.evaluate((value) => globalThis.ReactiveResumeAutofill.fill(document, value), packet);
		const state = await page.evaluate(() => ({ ...window.fixtureChoiceState, submits: window.fixtureSubmits, next: window.fixtureNext }));
		assert.equal(state.visa, "no");
		assert.equal(state.consent, true);
		assert.equal(state.submits, 0);
		assert.equal(state.next, 0);
	});
});

test("Workday-style listbox button and wrapping native label are both supported", { skip: skipReason }, async () => {
	await withPage(async (page) => {
		const preview = await page.evaluate((packet) => globalThis.ReactiveResumeAutofill.plan(document, packet), demoPacket);
		assert.ok(preview.fields.some((field) => field.label === "Country" && field.type === "combobox"));
		await page.evaluate((packet) => globalThis.ReactiveResumeAutofill.fill(document, packet), demoPacket);
		assert.equal(await page.locator("#country").inputValue(), "US");
		assert.equal(await page.evaluate(() => window.fixtureChoiceState.country), "US");
		assert.equal(await page.evaluate(() => window.fixtureSubmits), 0);
	});
});

test("common approvals fill bounded Ashby/native/ARIA questions and preserve manual opt-out by default", { skip: skipReason }, async () => {
	await withPage(async (page) => {
		await page.evaluate((packet) => globalThis.ReactiveResumeAutofill.fill(document, packet), demoPacket);
		assert.equal(await page.locator("#government-no").isChecked(), false);
		assert.equal(await page.locator("#race-decline").isChecked(), false);
		assert.equal(await page.locator("#aria-female").getAttribute("aria-checked"), "false");
		const packet = { ...demoPacket, commonAnswers: { priorGovernmentEmployment: "No", gender: "Female", race: "Decline to self-identify" } };
		const plan = await page.evaluate((value) => globalThis.ReactiveResumeAutofill.plan(document, value), packet);
		assert.ok(plan.fields.some((field) => field.label === "Prior Government Employment?" && field.status === "matched"));
		assert.ok(plan.fields.some((field) => field.label === "Race" && field.status === "matched"));
		await page.evaluate((value) => globalThis.ReactiveResumeAutofill.fill(document, value), packet);
		assert.equal(await page.locator("#government-no").isChecked(), true);
		assert.equal(await page.locator("#race-decline").isChecked(), true);
		assert.equal(await page.locator("#aria-female").getAttribute("aria-checked"), "true");
		assert.equal(await page.evaluate(() => window.fixtureSubmits), 0);
	});
});

test("separate resume and cover-letter PDFs retain their own bytes in native file inputs", { skip: skipReason }, async () => {
	await withPage(async (page) => {
		const resume = { base64: Buffer.from("%PDF-1.7\nfictional resume").toString("base64"), fileName: "Resume.pdf" };
		const coverLetter = { base64: Buffer.from("%PDF-1.7\nfictional cover letter").toString("base64"), fileName: "Cover.pdf" };
		await page.evaluate((packet) => globalThis.ReactiveResumeAutofill.fill(document, packet), { ...demoPacket, resume, coverLetter });
		assert.deepEqual(await page.evaluate(async () => ({
			resume: await document.querySelector("#resume").files[0].text(),
			cover: await document.querySelector("#cover").files[0].text(),
		})), { resume: "%PDF-1.7\nfictional resume", cover: "%PDF-1.7\nfictional cover letter" });
	});
});

async function withPopupPages(run) {
	const browser = await chromium.launch({ executablePath: executable, headless: true, args: ["--no-sandbox"] });
	try {
		const context = await browser.newContext();
		const files = new Map(["popup.html", "autofill.css", "src/autofill-popup.js", "src/autofill-drafts.js"]
			.map((name) => [`/${name}`, fs.readFileSync(path.join(extensionRoot, name), "utf8")]));
		await context.route("http://autofill.test/**", (route) => {
			const pathname = new URL(route.request().url()).pathname;
			return route.fulfill({ status: files.has(pathname) ? 200 : 404, body: files.get(pathname) || "",
				contentType: pathname.endsWith(".js") ? "text/javascript" : pathname.endsWith(".css") ? "text/css" : "text/html" });
		});
		await context.addInitScript(() => {
			globalThis.chrome = { runtime: { sendMessage: async (message) => {
				let data;
				if (message.type === "autofill-state") data = { configured: false, previewToken: "fixture-preview", draftContext: {
					sessionId: "browser-fixture", tabId: 7, tabUrl: "https://employer.example.test/apply/123",
				} };
				else if (message.type === "autofill-preview") {
					globalThis.lastPreview = message;
					data = { token: "fixture-preview", tabUrl: "https://employer.example.test/apply/123", application: { company: message.company, role: message.role },
						fileName: message.manualResume.fileName, message: "Review the selected fields.", fields: [
							{ id: "0:email", fieldId: "email", label: "Email", status: "matched", value: "example@example.test" },
							{ id: "0:phone", fieldId: "phone", label: "Phone", status: "matched", value: "555-0100" },
						] };
				} else if (message.type === "autofill-fill") { globalThis.lastFill = message; data = { reports: [], message: "Review the employer page." }; }
				else if (message.type === "autofill-clear-draft") data = {};
				else throw new Error("Unexpected fixture message");
				return { ok: true, data };
			} } };
		});
		const open = async () => {
			const page = await context.newPage();
			await page.goto("http://autofill.test/popup.html");
			await page.locator("#workspace:not([disabled])").waitFor();
			return page;
		};
		await run(open);
	} finally { await browser.close(); }
}

test("popup recreation retains real IndexedDB File bytes, text and unchecked review fields", { skip: skipReason }, async () => {
	await withPopupPages(async (open) => {
		let page = await open();
		await page.locator("#company").fill("Example Robotics");
		await page.locator("#role").fill("Autonomy Engineer");
		// This PDF's base64 would exceed chrome.storage.session's 10 MB quota.
		const bytes = Buffer.alloc(8 * 1024 * 1024, 32); bytes.write("%PDF-1.7\nfictional resume");
		await page.locator("#pdf").setInputFiles({ name: "Exact-Resume.pdf", mimeType: "application/pdf", buffer: bytes });
		await page.locator("#draft-status").filter({ hasText: "Draft saved" }).waitFor();
		await page.close();
		page = await open();
		assert.equal(await page.locator("#company").inputValue(), "Example Robotics");
		assert.equal(await page.locator("#role").inputValue(), "Autonomy Engineer");
		assert.deepEqual(await page.locator("#pdf").evaluate((input) => ({ name: input.files[0].name, size: input.files[0].size })), { name: "Exact-Resume.pdf", size: bytes.length });
		await page.locator("#preview").click(); await page.locator("#review").waitFor();
		await page.locator('#fields input[value="0:phone"]').uncheck();
		await page.locator("#draft-status").filter({ hasText: "Draft saved" }).waitFor();
		await page.close();
		page = await open();
		assert.equal(await page.locator('#fields input[value="0:phone"]').isChecked(), false);
		await page.locator("#fill").click();
		await page.waitForFunction(() => Boolean(globalThis.lastFill));
		assert.deepEqual(await page.evaluate(() => globalThis.lastFill.fieldIds), ["0:email"]);
		assert.equal(await page.evaluate(() => atob(globalThis.lastFill.manualResume.base64).length), bytes.length);
	});
});

test("browser draft store isolates pages and deletes closed-tab and old-session files", { skip: skipReason }, async () => {
	await withPopupPages(async (open) => {
		const page = await open();
		const result = await page.evaluate(async () => {
			const { openAutofillDraftStore, deleteAutofillTabDrafts } = await import("/src/autofill-drafts.js");
			const context = { sessionId: "browser-fixture", tabId: 7, tabUrl: "https://employer.example.test/apply/123" };
			const original = await openAutofillDraftStore(context);
			await original.write({ company: "Original", file: new File(["%PDF-1.7"], "Original.pdf") });
			const otherTab = await openAutofillDraftStore({ ...context, tabId: 8 });
			const otherPage = await openAutofillDraftStore({ ...context, tabUrl: "https://employer.example.test/apply/456" });
			const isolated = !await otherTab.read() && !await otherPage.read();
			await deleteAutofillTabDrafts(7);
			const closedTabDeleted = !await original.read();
			await original.write({ company: "Expired session", file: new File(["%PDF-1.7"], "Old.pdf") });
			await openAutofillDraftStore({ ...context, sessionId: "new-browser-session" });
			return { isolated, closedTabDeleted, oldSessionDeleted: !await original.read() };
		});
		assert.deepEqual(result, { isolated: true, closedTabDeleted: true, oldSessionDeleted: true });
	});
});
