import assert from "node:assert/strict";
import test from "node:test";
import { addCapture, captureBody, captureFailed, captureSucceeded, dueCaptures, normalizedBaseUrl } from "../src/outbox.js";
import "../src/extractor.js";

const payload = { url: "https://example.com/jobs?id=123", canonicalUrl: "https://example.com/jobs?id=123", company: "Example", role: "Engineer", description: "Real job text", extraction: "text", capturedAt: "2026-10-19T00:00:00Z" };

test("capture persists before sending and a serialized worker restart retains its stable ID", () => {
	const { items, item } = addCapture([], payload, "stable-id", 100);
	const restored = JSON.parse(JSON.stringify(items));
	assert.equal(restored[0].body.clientCaptureId, "stable-id");
	assert.equal(dueCaptures(restored, 100)[0].id, item.id);
	assert.equal(addCapture(restored, payload, "different-id", 200).items.length, 1);
});
test("a lost response retries the same idempotency ID without losing the captured description", () => {
	const first = addCapture([], payload, "stable-id", 100).item;
	const retry = captureFailed(first, "Network unavailable", false, 200);
	assert.equal(retry.body.clientCaptureId, first.body.clientCaptureId);
	assert.equal(retry.body.description, payload.description);
	assert.equal(dueCaptures([retry], 201).length, 0);
	assert.equal(dueCaptures([retry], retry.nextAttemptAt).length, 1);
});
test("a rendered capture upgrades a pending empty placeholder without losing its stable identity", () => {
	const placeholder = addCapture([], { ...payload, company: "jobright.ai", companyFallback: true, roleFallback: true, description: "" }, "first", 100);
	const upgraded = addCapture(placeholder.items, { ...payload, companyFallback: false, roleFallback: false }, "unused", 200);
	assert.equal(upgraded.items.length, 1);
	assert.equal(upgraded.item.body.clientCaptureId, "first");
	assert.equal(upgraded.item.body.description, payload.description);
	assert.equal(upgraded.item.body.company, "Example");
	assert.equal(upgraded.item.body.companyFallback, false);
});
test("only a confirmed application ID marks a capture saved", () => {
	const item = addCapture([], payload, "one").item;
	assert.throws(() => captureSucceeded(item, { result: "created" }), /confirm/);
	const saved = captureSucceeded(item, { id: "app-1", result: "duplicate", state: "pending", warnings: [] });
	assert.equal(saved.status, "saved");
	assert.equal(saved.result.id, "app-1");
	assert.equal(dueCaptures([saved]).length, 0);
});
test("recapturing an incomplete nonempty description retains improved text for repair", () => {
	const short = addCapture([], { ...payload, company: "jobright.ai", companyFallback: true,
		description: "Responsibilities\nResponsibilities\nQualification\nRepresents the skills you have" }, "first").item;
	const saved = captureSucceeded(short, { id: "app-1", result: "duplicate", state: "needs_details", warnings: [] });
	const full = { ...payload, company: "Example", companyFallback: false, descriptionIncomplete: false,
		description: "Develop reliable automation pipelines, test model deployments, and investigate production failures. Required: Python and experience building maintainable software systems." };
	const result = addCapture([saved], full, "unused");
	assert.equal(result.item.body.description, full.description);
	assert.equal(result.item.body.company, "Example");
	assert.equal(result.item.body.descriptionIncomplete, false);
	assert.equal(result.item.body.clientCaptureId, "first");
});
test("permanent errors retain captured data for user correction", () => {
	const item = addCapture([], payload, "one").item;
	const failed = captureFailed(item, "Expired key", true);
	assert.equal(failed.status, "failed");
	assert.equal(failed.body.description, payload.description);
	assert.equal(dueCaptures([failed]).length, 0);
});
test("duplicate placeholders retain full captured description for explicit manual repair", () => {
	const item = addCapture([], { ...payload, description: "x".repeat(2000) }, "one").item;
	const saved = captureSucceeded(item, { id: "app-1", result: "duplicate", state: "needs_details", warnings: [] });
	assert.equal(saved.status, "attention");
	assert.equal(saved.body.description.length, 2000);
	assert.equal(dueCaptures([saved]).length, 0);
	const next = addCapture([saved], { ...payload, canonicalUrl: "https://example.com/other" }, "two");
	assert.equal(next.items[0].body.description.length, 2000);
});
test("storage cap rejects new work without evicting pending jobs", () => {
	const pending = Array.from({ length: 250 }, (_, index) => ({ ...addCapture([], payload, String(index)).item, body: { ...payload, canonicalUrl: `https://example.com/${index}` } }));
	assert.throws(() => addCapture(pending, payload, "overflow"), /outbox is full/);
	assert.equal(pending.length, 250);
});
test("capture request contains only strict API fields and preserves server truncation detection", () => {
	const body = captureBody({ ...payload, description: "x".repeat(25001), warnings: ["review"], hostileExtra: "never sent" }, "one");
	assert.equal(body.description.length, 25001);
	assert.equal(body.warnings, undefined);
	assert.equal(body.hostileExtra, undefined);
	assert.equal(body.clientCaptureId, "one");
});
test("installation config accepts local origin or HTTPS and rejects credential leaks", () => {
	assert.equal(normalizedBaseUrl("http://localhost:3000/"), "http://localhost:3000");
	assert.equal(normalizedBaseUrl("https://resume.example"), "https://resume.example");
	for (const url of ["http://remote.example", "https://user:password@example.com", "https://example.com/path", "https://example.com/?key=secret"]) assert.throws(() => normalizedBaseUrl(url));
});
test("canonicalization removes tracking but retains job identity parameters and hash routes", () => {
	const canonical = globalThis.ReactiveCaptureExtract.canonicalUrl;
	assert.equal(canonical("https://example.com/jobs?id=42&utm_source=ad#job-42"), "https://example.com/jobs?id=42#job-42");
	assert.equal(canonical("https://jobright.ai/jobs/info/42?visit=one"), "https://jobright.ai/jobs/info/42");
	assert.throws(() => canonical("javascript:alert(1)"));
});
