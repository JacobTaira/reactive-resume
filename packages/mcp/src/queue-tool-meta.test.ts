import { describe, expect, it } from "vitest";
import { MCP_TOOL_NAME as T } from "./mcp-tool-names";
import { TOOL_META } from "./tool-meta";

describe("queue MCP contracts", () => {
	it("defaults compact listing and validates state/pagination bounds", () => {
		const schema = TOOL_META[T.listTailoringQueue].inputSchema;
		expect(schema.parse({})).toMatchObject({ limit: 30, offset: 0, includeDescription: false });
		expect(schema.parse({ states: ["needs_details", "failed"], limit: 4, includeDescription: true })).toMatchObject({
			states: ["needs_details", "failed"], limit: 4, includeDescription: true,
		});
		expect(schema.safeParse({ states: ["applied"] }).success).toBe(false);
		expect(schema.safeParse({ limit: 101 }).success).toBe(false);
		expect(schema.safeParse({ offset: -1 }).success).toBe(false);
	});

	it("requires revisions and lease tokens for finishing instead of allowing unguarded ready writes", () => {
		const finish = TOOL_META[T.finishQueueJob].inputSchema;
		expect(finish.safeParse({ id: "app", outcome: "ready" }).success).toBe(false);
		expect(finish.safeParse({ id: "app", expectedRevision: 1, leaseToken: "too-short", outcome: "ready" }).success).toBe(false);
		expect(finish.safeParse({
			id: "app", expectedRevision: 2, leaseToken: "private-workflow-token-123", outcome: "ready",
			draftResumeId: "draft", expectedResumeUpdatedAt: "2026-10-19T03:00:00Z",
		}).success).toBe(true);
		expect(finish.safeParse({
			id: "app", expectedRevision: 2, leaseToken: "private-workflow-token-123", outcome: "applied",
		}).success).toBe(false);
		expect(TOOL_META[T.claimQueueJob].inputSchema.safeParse({ id: "app", expectedRevision: 0, leaseSeconds: 1801 }).success).toBe(false);
	});

	it("supports durable evidence questions without silently resetting untouched fields", () => {
		const input = { id: "app", expectedRevision: 3, state: "needs_details", notes: "User must confirm testing work." };
		expect(TOOL_META[T.updateQueueJob].inputSchema.parse(input)).toEqual(input);
		expect(TOOL_META[T.updateQueueJob].inputSchema.safeParse({ ...input, state: "ready" }).success).toBe(false);
		expect(TOOL_META[T.skipQueueJob].inputSchema.safeParse({ id: "app", expectedRevision: 3, action: "requeue" }).success).toBe(false);
	});

	it("keeps reads local and writes explicit while documenting page-content trust", () => {
		for (const name of [T.listTailoringQueue, T.readTailoringQueueJob]) {
			expect(TOOL_META[name].annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
			expect(TOOL_META[name].description).toContain("third-party page content");
			expect(TOOL_META[name].description).toContain("untrusted data");
		}
		for (const name of [T.claimQueueJob, T.updateQueueJob, T.finishQueueJob, T.skipQueueJob, T.requeueJob]) {
			expect(TOOL_META[name].annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
		}
	});
});
