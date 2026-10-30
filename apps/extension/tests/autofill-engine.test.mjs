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
