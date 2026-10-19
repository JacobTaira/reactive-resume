import type { QueueItem } from "@reactive-resume/api/dto/capture";

export type QueueState = QueueItem["preparation"]["state"];
export type QueueCounts = Record<QueueState, number>;
export type QueueFilter = "active" | QueueState;

export const ACTIVE_QUEUE_STATES: QueueState[] = ["pending", "needs_details", "processing", "failed"];

export function queueOutstandingCount(counts: Partial<QueueCounts>): number {
	return ACTIVE_QUEUE_STATES.reduce((total, state) => total + (counts[state] ?? 0), 0);
}

export function queueFilterStates(filter: QueueFilter): QueueState[] {
	return filter === "active" ? [...ACTIVE_QUEUE_STATES] : [filter];
}

export function queueCanRequeue(item: Pick<QueueItem, "applicationStatus" | "preparation">): boolean {
	return item.applicationStatus === "saved" && ["failed", "ready", "skipped"].includes(item.preparation.state);
}
