import type { QueueItem } from "@reactive-resume/api/dto/capture";
import { describe, expect, it } from "vitest";
import { queueCanRequeue, queueFilterStates, queueOutstandingCount } from "./queue-model";

describe("capture queue visibility", () => {
	it("includes missing details, failures and in-progress jobs in the outstanding badge", () => {
		expect(queueOutstandingCount({ pending: 2, needs_details: 3, failed: 4, processing: 1, ready: 7, skipped: 9 })).toBe(10);
		expect(queueFilterStates("active")).toEqual(["pending", "needs_details", "processing", "failed"]);
		expect(queueFilterStates("ready")).toEqual(["ready"]);
	});

	it("never requeues a submitted application or interrupts a working agent", () => {
		const item = (applicationStatus: string, state: QueueItem["preparation"]["state"]) => ({
			applicationStatus,
			preparation: {
				state,
				revision: 1,
				draftResumeId: null,
				notes: "",
				error: "",
				leaseExpiresAt: null,
				updatedAt: "2026-10-19T00:00:00Z",
			},
		});
		expect(queueCanRequeue(item("saved", "failed"))).toBe(true);
		expect(queueCanRequeue(item("saved", "skipped"))).toBe(true);
		expect(queueCanRequeue(item("applied", "ready"))).toBe(false);
		expect(queueCanRequeue(item("saved", "processing"))).toBe(false);
	});
});
