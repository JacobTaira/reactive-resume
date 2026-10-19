import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const TOOL_TIMING_META_KEY = "reactive-resume/tool-timing";

/** Handler duration only; excludes the client's reasoning, network and local commands. */
type ToolTiming = {
	operation: string;
	elapsedMs: number;
	outcome: "ok" | "failed";
};

/**
 * Attach timing to this call's result and emit content-free server diagnostics.
 * `operation` must be a static registration label, never caller-supplied input.
 * No call history, request contents, record IDs, credentials or identities are retained.
 */
export function withToolTiming<T, Args extends unknown[]>(
	operation: string,
	handler: (params: T, ...args: Args) => Promise<CallToolResult>,
	now: () => number = () => performance.now(),
) {
	return async (params: T, ...args: Args): Promise<CallToolResult> => {
		const startedAt = now();
		const timing = (outcome: ToolTiming["outcome"]): ToolTiming => ({
			operation,
			elapsedMs: Math.max(0, Math.round(now() - startedAt)),
			outcome,
		});

		let result: CallToolResult;
		try {
			result = await handler(params, ...args);
		} catch (error) {
			console.info("MCP tool timing", JSON.stringify(timing("failed")));
			throw error;
		}

		const measurement = timing(result.isError ? "failed" : "ok");
		console.info("MCP tool timing", JSON.stringify(measurement));
		return { ...result, _meta: { ...result._meta, [TOOL_TIMING_META_KEY]: measurement } };
	};
}
