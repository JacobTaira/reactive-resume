import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureInputSchema } from "../../dto/capture";

const mocks = vi.hoisted(() => ({ existing: [] as Record<string, unknown>[], inserted: [] as Record<string, unknown>[], events: [] as string[] }));
vi.mock("@reactive-resume/env/server", () => ({ env: { APP_URL: "http://localhost:3000" } }));
vi.mock("@reactive-resume/db/client", () => {
 const tx = {
  select: (selection: Record<string, unknown>) => ({ from: () => ({ where: () => ({
   for: async () => { mocks.events.push("owner-lock"); return [{ id: "owner" }]; },
   orderBy: async () => { mocks.events.push("lookup"); return "sourceUrl" in selection ? mocks.existing : []; },
  }) }) }),
  insert: () => ({ values: async (row: Record<string, unknown>) => { mocks.events.push("insert"); mocks.inserted.push(row); } }),
 };
 return { db: { transaction: async (callback: (client: unknown) => unknown) => callback(tx) } };
});
const { captureService } = await import("./capture");
const input = (patch = {}) => captureInputSchema.parse({ url: "https://jobright.ai/jobs/info/abc?visit=liked", company: "Acme", role: "Engineer", description: "Build tools", extraction: "adapter", capturedAt: new Date().toISOString(), ...patch });
beforeEach(() => { mocks.existing.length = 0; mocks.inserted.length = 0; mocks.events.length = 0; });

describe("atomic capture transaction", () => {
 it("locks the owner before duplicate lookup and inserts only saved snapshots", async () => {
  const result = await captureService.capture("owner", input({ description: "x".repeat(20_001) }));
  expect(mocks.events).toEqual(["owner-lock", "lookup", "insert"]);
  expect(result.result).toBe("created");
  expect(mocks.inserted[0]).toMatchObject({ userId: "owner", status: "saved", sourceUrl: "https://jobright.ai/jobs/info/abc", postingSource: { method: "extension", truncated: true } });
  expect((mocks.inserted[0]?.jobDescription as string).length).toBe(20_000);
 });
 it("recognizes legacy tracked URLs and preserves already-applied history", async () => {
  mocks.existing.push({ id: "old", sourceUrl: "https://jobright.ai/jobs/info/abc?visit=other", captureIdentity: null, capture: null, preparation: null, status: "applied", company: "Acme", role: "Engineer", jobDescription: "Existing text", tags: [], createdAt: new Date() });
  const result = await captureService.capture("owner", input());
  expect(result).toMatchObject({ id: "old", result: "duplicate", applicationStatus: "applied" });
  expect(mocks.inserted).toHaveLength(0);
 });
 it("warns about a possible matching role without dropping a distinct vacancy", async () => {
  mocks.existing.push({ id: "other", sourceUrl: "https://jobright.ai/jobs/info/different", captureIdentity: null, capture: null, preparation: null, status: "saved", company: "ACME", role: " engineer ", jobDescription: "Text", tags: [], createdAt: new Date() });
  const result = await captureService.capture("owner", input());
  expect(result.result).toBe("created");
  expect(result.possibleDuplicateOf).toBe("other");
  expect(mocks.inserted).toHaveLength(1);
 });
 it("does not overwrite incomplete duplicates and clearly reports repair needed", async () => {
  mocks.existing.push({ id: "old", sourceUrl: input().url, captureIdentity: null, capture: null, preparation: null, status: "saved", company: "Acme", role: "Engineer", jobDescription: "", tags: [], createdAt: new Date() });
  const result = await captureService.capture("owner", input());
  expect(result.state).toBe("needs_details");
  expect(result.warnings.join(" ")).toContain("needs repair");
  expect(mocks.inserted).toHaveLength(0);
 });
 it("isolates malformed items in a capture batch", async () => {
  const result = await captureService.batch("owner", [{ wrong: true }, input()]);
  expect(result.results[0]?.error?.code).toBe("INVALID_INPUT");
  expect(result.results[1]?.result?.result).toBe("created");
  expect(mocks.inserted).toHaveLength(1);
 });
});
