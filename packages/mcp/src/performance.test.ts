import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOOL_TIMING_META_KEY, withToolTiming } from "./performance";

describe("MCP handler timing", () => {
	afterEach(() => vi.restoreAllMocks());

	it("times the completed handler and preserves its data and existing metadata", async () => {
		const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const now = vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(145.6);
		const original: CallToolResult = {
			content: [{ type: "text", text: "private resume content" }],
			structuredContent: { privateValue: "do not log" },
			_meta: { existing: true },
		};
		const handler = vi.fn(async () => original);
		const result = await withToolTiming("reading resume", handler, now)({ secret: "private credential" });
		const measurement = { operation: "reading resume", elapsedMs: 46, outcome: "ok" };

		expect(handler).toHaveBeenCalledWith({ secret: "private credential" });
		expect(result).toEqual({ ...original, _meta: { existing: true, [TOOL_TIMING_META_KEY]: measurement } });
		expect(original._meta).toEqual({ existing: true });
		expect(log).toHaveBeenCalledExactlyOnceWith("MCP tool timing", JSON.stringify(measurement));
		expect(JSON.stringify(log.mock.calls)).not.toMatch(/private|credential|do not log/);
	});

	it("includes failed-result timing without changing its sanitized error", async () => {
		const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const now = vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(90);
		const original: CallToolResult = {
			isError: true,
			content: [{ type: "text", text: "Permission denied." }],
		};
		const result = await withToolTiming("updating resume", async () => original, now)(undefined);
		const measurement = { operation: "updating resume", elapsedMs: 80, outcome: "failed" };

		expect(result).toEqual({ ...original, _meta: { [TOOL_TIMING_META_KEY]: measurement } });
		expect(log).toHaveBeenCalledExactlyOnceWith("MCP tool timing", JSON.stringify(measurement));
	});

	it("logs thrown failures without exposing their messages or replacing the error", async () => {
		const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const now = vi.fn().mockReturnValueOnce(5).mockReturnValueOnce(17);
		const failure = new Error("private database credential");
		const handler = withToolTiming(
			"compiling resume",
			async () => {
				throw failure;
			},
			now,
		);

		await expect(handler(undefined)).rejects.toBe(failure);
		expect(log).toHaveBeenCalledExactlyOnceWith(
			"MCP tool timing",
			JSON.stringify({ operation: "compiling resume", elapsedMs: 12, outcome: "failed" }),
		);
		expect(JSON.stringify(log.mock.calls)).not.toContain("private database credential");
	});

	it("keeps concurrent calls independent and never returns a negative duration", async () => {
		vi.spyOn(console, "info").mockImplementation(() => undefined);
		const firstClock = vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(125);
		const secondClock = vi.fn().mockReturnValueOnce(90).mockReturnValueOnce(89.9);
		const handler = async () => ({ content: [] });
		const [first, second] = await Promise.all([
			withToolTiming("first", handler, firstClock)(undefined),
			withToolTiming("second", handler, secondClock)(undefined),
		]);

		expect(first._meta?.[TOOL_TIMING_META_KEY]).toEqual({ operation: "first", elapsedMs: 25, outcome: "ok" });
		expect(second._meta?.[TOOL_TIMING_META_KEY]).toEqual({ operation: "second", elapsedMs: 0, outcome: "ok" });
	});
});
