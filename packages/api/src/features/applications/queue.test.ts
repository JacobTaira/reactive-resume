import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ row: {} as Record<string, unknown>, draft: {} as Record<string, unknown>, updates: [] as Record<string, unknown>[], compile: vi.fn() }));
vi.mock("../resume/latex-compiler", () => ({ compileLatexProject: mocks.compile }));
vi.mock("@reactive-resume/db/client", () => {
 const tx = {
  select: (selection?: Record<string, unknown>) => ({ from: () => ({ where: () => {
   const rows = selection && "applicationId" in selection ? [{ ...mocks.draft }] : selection ? [{ id: "owner" }] : [{ ...mocks.row }];
   return { for: async () => rows, then: (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve) };
  } }) }),
  update: () => ({ set: (changes: Record<string, unknown>) => ({ where: () => {
   const save = () => { mocks.updates.push(changes); const target = "profile" in changes ? mocks.draft : mocks.row; Object.assign(target, changes); return [target]; };
   return { returning: async () => save(), then: (resolve: (value: unknown) => unknown) => Promise.resolve(save()).then(resolve) };
  } }) }),
 };
 return { db: { ...tx, transaction: async (callback: (client: unknown) => unknown) => callback(tx) } };
});
const { queueService } = await import("./queue");
const now = new Date();
const project = { engine: "pdflatex", entrypoint: "main.tex", files: [{ path: "main.tex", encoding: "utf-8", content: "Verified resume source" }] };
const pdfChecks = () => ({
 pageCount: 1, expectedPageCount: 1, pageCountMatches: true, pageCountError: null,
 overfullBoxes: { count: 0, messages: [], truncated: false },
 textExtraction: { status: "success", characterCount: 16, text: "Verified resume", preview: "Verified resume", truncated: false, error: null },
});
const basePreparation = () => ({ state: "pending", revision: 1, draftResumeId: null, notes: "Existing evidence notes", error: "", leaseExpiresAt: null, updatedAt: now.toISOString() });
beforeEach(() => {
 mocks.updates.length = 0;
 mocks.compile.mockReset().mockResolvedValue({ success: true, pdf: "JVBERi0=", log: "done", checks: pdfChecks() });
 mocks.row = { id: "job", userId: "owner", company: "Acme", role: "Engineer", location: null, sourceUrl: "https://example.com/job", status: "saved", capture: null, postingSource: null, jobDescription: "Build tools", preparation: basePreparation(), tags: [], createdAt: now, resumeId: null, sentResumeVersionId: null };
 mocks.draft = { id: "draft", applicationId: "job", updatedAt: now, data: { latex: project }, profile: { purpose: "tailored", score: 80, evaluatedResumeUpdatedAt: now.toISOString(), reviewedResumeUpdatedAt: now.toISOString() } };
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
 it("compiles the saved draft and completes without score, rubric, evidence or review metadata", async () => {
  const claimed = await queueService.claim({ userId: "owner", id: "job", expectedRevision: 1, leaseSeconds: 900 });
  mocks.draft.profile = { existing: "preserve" };
  const result = await queueService.finish({ userId: "owner", id: "job", expectedRevision: 2, leaseToken: claimed.leaseToken, outcome: "ready", draftResumeId: "draft", expectedResumeUpdatedAt: now.toISOString(), verifyPdf: true, expectedPageCount: 1 });
  expect(mocks.compile).toHaveBeenCalledExactlyOnceWith(project, { expectedPageCount: 1 });
  expect(result.preparation.state).toBe("ready");
  expect(mocks.row.resumeId).toBe("draft");
  expect(mocks.row.status).toBe("saved");
  expect(mocks.draft.profile).toEqual({ existing: "preserve" });
  expect(mocks.updates.some(update => "profile" in update)).toBe(false);
  expect(result.pdfVerification).toMatchObject({ pageCount: 1, textExtractionStatus: "success", overfullBoxes: { count: 0 } });
 });
 it("preserves bounded nonblocking overflow warnings in the verification result", async () => {
  const claimed = await queueService.claim({ userId: "owner", id: "job", expectedRevision: 1, leaseSeconds: 900 });
  const overfullBoxes = { count: 1, messages: ["Overfull box: review the affected line"], truncated: false };
  mocks.compile.mockResolvedValueOnce({ success: true, pdf: "private-pdf-bytes", log: "done", checks: { ...pdfChecks(), overfullBoxes } });
  const result = await queueService.finish({ userId: "owner", id: "job", expectedRevision: 2, leaseToken: claimed.leaseToken, outcome: "ready", draftResumeId: "draft", expectedResumeUpdatedAt: now.toISOString(), verifyPdf: true });
  expect(result.pdfVerification).toEqual({ pageCount: 1, overfullBoxes, textExtractionStatus: "success" });
  expect(result.preparation.state).toBe("ready");
  expect(JSON.stringify(result)).not.toContain("private-pdf-bytes");
 });
 it("optionally stores a score against the actual verified snapshot without changing document timestamps", async () => {
  const claimed = await queueService.claim({ userId: "owner", id: "job", expectedRevision: 1, leaseSeconds: 900 });
  mocks.draft.profile = { company: "Acme", reuseNotes: "Useful experience" };
  await queueService.finish({ userId: "owner", id: "job", expectedRevision: 2, leaseToken: claimed.leaseToken, outcome: "ready", draftResumeId: "draft", expectedResumeUpdatedAt: now.toISOString(), verifyPdf: true, score: 88 });
  expect(mocks.draft.profile).toMatchObject({ company: "Acme", reuseNotes: "Useful experience", purpose: "tailored", score: 88, evaluatedResumeUpdatedAt: now.toISOString() });
  expect(mocks.draft.updatedAt).toBe(now);
 });
 it.each([
  ["missing diagnostics", { success: true, pdf: "JVBERi0=", log: "done" }],
  ["page target mismatch", { success: true, pdf: "JVBERi0=", log: "done", checks: { ...pdfChecks(), pageCount: 2 } }],
  ["failed extraction", { success: true, pdf: "JVBERi0=", log: "done", checks: { ...pdfChecks(), textExtraction: { ...pdfChecks().textExtraction, status: "failed" } } }],
  ["empty extracted text", { success: true, pdf: "JVBERi0=", log: "done", checks: { ...pdfChecks(), textExtraction: { ...pdfChecks().textExtraction, text: " " } } }],
  ["unknown page count", { success: true, pdf: "JVBERi0=", log: "done", checks: { ...pdfChecks(), pageCount: null } }],
  ["compile failure", { success: false, log: "Compilation failed" }],
 ])("leaves the draft processing after %s", async (_label, compilerResult) => {
  const claimed = await queueService.claim({ userId: "owner", id: "job", expectedRevision: 1, leaseSeconds: 900 });
  mocks.compile.mockResolvedValueOnce(compilerResult);
  await expect(queueService.finish({ userId: "owner", id: "job", expectedRevision: 2, leaseToken: claimed.leaseToken, outcome: "ready", draftResumeId: "draft", expectedResumeUpdatedAt: now.toISOString(), verifyPdf: true, expectedPageCount: 1 })).rejects.toMatchObject({ code: "QUEUE_PDF_CHECK_FAILED", status: 400, data: { resumeUpdatedAt: now.toISOString() } });
  expect((mocks.row.preparation as { state: string }).state).toBe("processing");
  expect(mocks.row.resumeId).toBe(null);
 });
 it("reports bounded compiler diagnostics without returning PDF bytes", async () => {
  const claimed = await queueService.claim({ userId: "owner", id: "job", expectedRevision: 1, leaseSeconds: 900 });
  mocks.compile.mockResolvedValueOnce({ success: false, pdf: "private-pdf-bytes", log: "x".repeat(4000) });
  const failure = await queueService.finish({ userId: "owner", id: "job", expectedRevision: 2, leaseToken: claimed.leaseToken, outcome: "ready", draftResumeId: "draft", expectedResumeUpdatedAt: now.toISOString(), verifyPdf: true }).catch(error => error);
  expect(failure.data).toMatchObject({ compilationSucceeded: false, checks: null });
  expect(failure.data.log).toHaveLength(2000);
  expect(JSON.stringify(failure.data)).not.toContain("private-pdf-bytes");
 });
 it("rejects a draft edited during compilation and preserves the queue revision", async () => {
  const claimed = await queueService.claim({ userId: "owner", id: "job", expectedRevision: 1, leaseSeconds: 900 });
  mocks.compile.mockImplementationOnce(async () => {
   mocks.draft.updatedAt = new Date(now.getTime() + 1000);
   return { success: true, pdf: "JVBERi0=", log: "done", checks: pdfChecks() };
  });
  await expect(queueService.finish({ userId: "owner", id: "job", expectedRevision: 2, leaseToken: claimed.leaseToken, outcome: "ready", draftResumeId: "draft", expectedResumeUpdatedAt: now.toISOString(), verifyPdf: true })).rejects.toMatchObject({ code: "CONFLICT" });
  expect((mocks.row.preparation as { state: string; revision: number }).state).toBe("processing");
  expect((mocks.row.preparation as { revision: number }).revision).toBe(2);
 });
 it("checks revision and lease before compiling", async () => {
  const claimed = await queueService.claim({ userId: "owner", id: "job", expectedRevision: 1, leaseSeconds: 900 });
  await expect(queueService.finish({ userId: "owner", id: "job", expectedRevision: 1, leaseToken: claimed.leaseToken, outcome: "ready", draftResumeId: "draft", expectedResumeUpdatedAt: now.toISOString(), verifyPdf: true })).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(queueService.finish({ userId: "owner", id: "job", expectedRevision: 2, leaseToken: "wrong-lease-token-123456789", outcome: "ready", draftResumeId: "draft", expectedResumeUpdatedAt: now.toISOString(), verifyPdf: true })).rejects.toMatchObject({ code: "CONFLICT" });
  expect(mocks.compile).not.toHaveBeenCalled();
 });
 it.each(["stage", "revision", "lease", "link", "submission"])("rechecks %s after compilation before any metadata write", async reason => {
  const claimed = await queueService.claim({ userId: "owner", id: "job", expectedRevision: 1, leaseSeconds: 900 });
  mocks.compile.mockImplementationOnce(async () => {
   if (reason === "stage") mocks.row.status = "applied";
   if (reason === "revision") (mocks.row.preparation as { revision: number }).revision = 3;
   if (reason === "lease") (mocks.row.preparation as { leaseExpiresAt: string }).leaseExpiresAt = new Date(Date.now() - 1000).toISOString();
   if (reason === "link") mocks.draft.applicationId = "different-job";
   if (reason === "submission") mocks.row.sentResumeVersionId = "sent-version";
   return { success: true, pdf: "JVBERi0=", log: "done", checks: pdfChecks() };
  });
  await expect(queueService.finish({ userId: "owner", id: "job", expectedRevision: 2, leaseToken: claimed.leaseToken, outcome: "ready", draftResumeId: "draft", expectedResumeUpdatedAt: now.toISOString(), verifyPdf: true, score: 88 })).rejects.toBeDefined();
  expect(mocks.updates.some(update => "profile" in update)).toBe(false);
  expect(mocks.row.resumeId).toBe(null);
 });
 it.each(["unlinked", "submitted", "ordinary", "stale"])("blocks %s drafts before compilation", async reason => {
  const claimed = await queueService.claim({ userId: "owner", id: "job", expectedRevision: 1, leaseSeconds: 900 });
  if (reason === "unlinked") mocks.draft.applicationId = "another-job";
  if (reason === "submitted") mocks.row.sentResumeVersionId = "recorded-submission";
  if (reason === "ordinary") mocks.draft.data = { basics: { name: "Candidate" } };
  if (reason === "stale") mocks.draft.updatedAt = new Date(now.getTime() + 1000);
  await expect(queueService.finish({ userId: "owner", id: "job", expectedRevision: 2, leaseToken: claimed.leaseToken, outcome: "ready", draftResumeId: "draft", expectedResumeUpdatedAt: now.toISOString(), verifyPdf: true })).rejects.toBeDefined();
  expect(mocks.compile).not.toHaveBeenCalled();
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
