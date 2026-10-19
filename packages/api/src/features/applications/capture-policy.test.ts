import { describe, expect, it } from "vitest";
import { captureInputSchema } from "../../dto/capture";
import { canonicalPostingUrl, cleanCaptureText, initialPreparation, postingIdentity, prepareCapture } from "./capture-policy";

const now = new Date("2026-10-19T02:00:00.000Z");
const input = (patch = {}) => captureInputSchema.parse({ url: "https://jobright.ai/jobs/info/job123?visit=liked&utm_source=email", company: "Acme", role: "Engineer", description: "Build tools", extraction: "adapter", capturedAt: now.toISOString(), ...patch });

describe("deterministic capture policy", () => {
 it("normalizes Jobright visits but preserves other providers' functional query IDs", () => {
  expect(canonicalPostingUrl(input().url)).toBe("https://jobright.ai/jobs/info/job123");
  expect(canonicalPostingUrl("https://jobs.example/job?visit=123&gh_jid=456&utm_source=test#job" )).toBe("https://jobs.example/job?gh_jid=456&visit=123#job");
  expect(postingIdentity("https://www.jobright.ai/jobs/info/job123?visit=x")).toBe(postingIdentity(input().url));
 });
 it("does not collapse known Jobright posting IDs through an incorrect canonical link", () => {
  const one = prepareCapture(input({ canonicalUrl: "https://jobright.ai/" }), now);
  const two = prepareCapture(input({ url: "https://jobright.ai/jobs/info/other", canonicalUrl: "https://jobright.ai/" }), now);
  expect(one.identity).not.toBe(two.identity);
  expect(one.canonicalUrl).toBe("https://jobright.ai/jobs/info/job123");
 });
 it("retains distinct SPA hash routes", () => {
  expect(postingIdentity("https://example.com/#/jobs/123")).not.toBe(postingIdentity("https://example.com/#/jobs/456"));
 });
 it("refuses cross-origin canonical identity and strips credentials", () => {
  const result = prepareCapture(input({ url: "https://person:secret@jobright.ai/jobs/info/job123", canonicalUrl: "https://hostile.example/other" }), now);
  expect(result.canonicalUrl).toBe("https://jobright.ai/jobs/info/job123");
  expect(result.identity).toBe("jobright:job123");
 });
 it("clips description at 20,000 characters and reports truncation", () => {
  expect(prepareCapture(input({ description: "x".repeat(20_000) }), now).truncated).toBe(false);
  const result = prepareCapture(input({ description: "x".repeat(20_001) }), now);
  expect(result.description).toHaveLength(20_000);
  expect(result.truncated).toBe(true);
 });
 it("keeps empty and fallback captures visible under needs details", () => {
  expect(prepareCapture(input({ description: "" }), now).preparation.state).toBe("needs_details");
  expect(prepareCapture(input({ company: "<b></b>" }), now).capture.companyFallback).toBe(true);
  expect(prepareCapture(input({ role: "", title: "Page title" }), now).preparation.state).toBe("needs_details");
  expect(prepareCapture(input(), now).preparation.state).toBe("pending");
 });
 it("does not preserve raw HTML or active page content", () => {
  expect(cleanCaptureText("<script>steal()</script><b>Build</b> **tools**\u0000")).toBe("Build **tools**");
 });
 it("does not mistake a copied draft for completed captured preparation", () => {
  const preparation = prepareCapture(input(), now).preparation;
  expect(initialPreparation({ preparation, capture: null, company: "Acme", role: "Engineer", jobDescription: "Text", tags: [], createdAt: now }, now).state).toBe("pending");
 });
 it("expired leases become visible failures and keep the draft/notes", () => {
  const preparation = { ...prepareCapture(input(), now).preparation, state: "processing" as const, leaseExpiresAt: now.toISOString(), draftResumeId: "draft", notes: "Need API evidence" };
  const result = initialPreparation({ preparation, capture: null, company: "Acme", role: "Engineer", jobDescription: "Text", tags: [], createdAt: now }, now);
  expect(result.state).toBe("failed");
  expect(result.draftResumeId).toBe("draft");
  expect(result.notes).toBe("Need API evidence");
 });
 it("keeps legacy placeholder captures needing details until explicitly confirmed", () => {
  const legacy = { preparation: null, capture: null, company: "Company not provided", role: "Role not provided", jobDescription: "Text", tags: ["needs-details"], createdAt: now };
  expect(initialPreparation(legacy, now).state).toBe("needs_details");
  expect(initialPreparation({ ...legacy, preparation: prepareCapture(input(), now).preparation }, now).state).toBe("pending");
 });
 it("respects skip tags on existing explicit preparation", () => {
  expect(initialPreparation({ preparation: prepareCapture(input(), now).preparation, capture: null, company: "Acme", role: "Engineer", jobDescription: "Text", tags: ["skip"], createdAt: now }, now).state).toBe("skipped");
 });
});
