import { describe, expect, it } from "vitest";
import { applicationPreparationSchema } from "@reactive-resume/schema/applications/data";
import { captureDto, captureInputSchema, queueDto } from "../../dto/capture";

describe("capture contracts", () => {
 it("disallows status changes, files and AI settings on capture", () => {
  const input = { url: "https://example.com/job", extraction: "text", capturedAt: new Date().toISOString() };
  expect(captureInputSchema.safeParse(input).success).toBe(true);
  for (const extra of [{ status: "applied" }, { resumeId: "master" }, { providerId: "x".repeat(301) }, { html: "<h1>Job</h1>" }]) expect(captureInputSchema.safeParse({ ...input, ...extra }).success).toBe(false);
 });
 it("bounds batches without validating all items together", () => {
  expect(captureDto.batch.input.safeParse({ items: [{ malformed: true }, null] }).success).toBe(true);
  expect(captureDto.batch.input.safeParse({ items: Array.from({ length: 51 }, () => ({})) }).success).toBe(false);
 });
 it("uses revision and lease claims rather than allowing arbitrary ready updates", () => {
  expect(queueDto.update.input.safeParse({ id: "job", expectedRevision: 1, state: "ready" }).success).toBe(false);
  expect(queueDto.claim.input.safeParse({ id: "job" }).success).toBe(false);
  expect(queueDto.finish.input.safeParse({ id: "job", expectedRevision: 1, outcome: "ready" }).success).toBe(false);
 });
 it("never serializes a stored lease token hash in public metadata", () => {
  const result = applicationPreparationSchema.parse({ state: "processing", revision: 1, draftResumeId: null, notes: "", error: "", leaseExpiresAt: null, updatedAt: new Date().toISOString(), leaseTokenHash: "secret" });
  expect(result).not.toHaveProperty("leaseTokenHash");
 });
});
