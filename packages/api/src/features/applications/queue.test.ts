import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ row: {} as Record<string, unknown>, draft: {} as Record<string, unknown>, updates: [] as Record<string, unknown>[] }));
vi.mock("@reactive-resume/db/client", () => {
 const tx = {
  select: (selection?: Record<string, unknown>) => ({ from: () => ({ where: () => ({ for: async () => selection && "applicationId" in selection ? [mocks.draft] : selection ? [{ id: "owner" }] : [mocks.row] }) }) }),
  update: () => ({ set: (changes: Record<string, unknown>) => ({ where: () => ({ returning: async () => { mocks.updates.push(changes); Object.assign(mocks.row, changes); return [mocks.row]; } }) }) }),
 };
 return { db: { ...tx, transaction: async (callback: (client: unknown) => unknown) => callback(tx) } };
});
const { queueService } = await import("./queue");
const now = new Date();
const basePreparation = () => ({ state: "pending", revision: 1, draftResumeId: null, notes: "Existing evidence notes", error: "", leaseExpiresAt: null, updatedAt: now.toISOString() });
beforeEach(() => {
 mocks.updates.length = 0;
 mocks.row = { id: "job", userId: "owner", company: "Acme", role: "Engineer", location: null, sourceUrl: "https://example.com/job", status: "saved", capture: null, postingSource: null, jobDescription: "Build tools", preparation: basePreparation(), tags: [], createdAt: now, resumeId: null, sentResumeVersionId: null };
 mocks.draft = { id: "draft", applicationId: "job", updatedAt: now, profile: { purpose: "tailored", score: 80, evaluatedResumeUpdatedAt: now.toISOString(), reviewedResumeUpdatedAt: now.toISOString() } };
});

describe("queue transaction transitions", () => {
 it("requires explicit description repair before processing incomplete captured sections", async () => {
  mocks.row.capture = { canonicalUrl: "https://example.com/job", capturedAt: now.toISOString(), extraction: "adapter", companyFallback: false, roleFallback: false, providerId: null, descriptionIncomplete: true };
  mocks.row.preparation = { ...basePreparation(), state: "needs_details" };
  const unchanged = await queueService.update({ userId: "owner", id: "job", expectedRevision: 1, notes: "Check qualification section" });
  expect(unchanged.preparation.state).toBe("needs_details");
  await expect(queueService.claim({ userId: "owner", id: "job", expectedRevision: 2, leaseSeconds: 900 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  const repaired = await queueService.update({ userId: "owner", id: "job", expectedRevision: 2, description: "Full verified responsibilities and qualification text" });
  expect(repaired.preparation.state).toBe("pending");
  expect(repaired.capture?.descriptionIncomplete).toBe(false);
 });
 it("recovers expired leases without the previous token", async () => {
  mocks.row.preparation = { ...basePreparation(), state: "processing", draftResumeId: "draft", leaseTokenHash: "a".repeat(64), leaseExpiresAt: new Date(Date.now() - 60_000).toISOString() };
  const result = await queueService.claim({ userId: "owner", id: "job", expectedRevision: 1, leaseSeconds: 900 });
  expect(result.item.preparation.state).toBe("processing");
  expect(result.item.preparation.revision).toBe(2);
  expect(result.item.preparation.draftResumeId).toBe("draft");
  expect(result.leaseToken).toHaveLength(64);
  expect(result.item.preparation).not.toHaveProperty("leaseTokenHash");
 });
 it("blocks simultaneous clients and stale revisions", async () => {
  await queueService.claim({ userId: "owner", id: "job", expectedRevision: 1, leaseSeconds: 900 });
  await expect(queueService.claim({ userId: "owner", id: "job", expectedRevision: 2, leaseSeconds: 900 })).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(queueService.action({ userId: "owner", id: "job", expectedRevision: 1, action: "skip" })).rejects.toMatchObject({ code: "CONFLICT" });
 });
 it("requires a reviewed current tailored draft before ready", async () => {
  const claimed = await queueService.claim({ userId: "owner", id: "job", expectedRevision: 1, leaseSeconds: 900 });
  mocks.draft.profile = { purpose: "tailored", score: null };
  await expect(queueService.finish({ userId: "owner", id: "job", expectedRevision: 2, leaseToken: claimed.leaseToken, outcome: "ready", draftResumeId: "draft", expectedResumeUpdatedAt: now.toISOString() })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect((mocks.row.preparation as { state: string }).state).toBe("processing");
 });
 it("ready selects the reviewed draft but never marks applied", async () => {
  const claimed = await queueService.claim({ userId: "owner", id: "job", expectedRevision: 1, leaseSeconds: 900 });
  const result = await queueService.finish({ userId: "owner", id: "job", expectedRevision: 2, leaseToken: claimed.leaseToken, outcome: "ready", draftResumeId: "draft", expectedResumeUpdatedAt: now.toISOString() });
  expect(result.preparation.state).toBe("ready");
  expect(mocks.row.resumeId).toBe("draft");
  expect(mocks.row.status).toBe("saved");
  expect(result.preparation.notes).toBe("Existing evidence notes");
 });
 it("skip invalidates processing and requeue retains the existing draft", async () => {
  const claimed = await queueService.claim({ userId: "owner", id: "job", expectedRevision: 1, leaseSeconds: 900 });
  await queueService.update({ userId: "owner", id: "job", expectedRevision: 2, leaseToken: claimed.leaseToken, draftResumeId: "draft" });
  await queueService.action({ userId: "owner", id: "job", expectedRevision: 3, action: "skip" });
  await expect(queueService.finish({ userId: "owner", id: "job", expectedRevision: 4, leaseToken: claimed.leaseToken, outcome: "failed" })).rejects.toMatchObject({ code: "CONFLICT" });
  const result = await queueService.action({ userId: "owner", id: "job", expectedRevision: 4, action: "requeue" });
  expect(result.preparation.state).toBe("pending");
  expect(result.preparation.draftResumeId).toBe("draft");
 });
});
