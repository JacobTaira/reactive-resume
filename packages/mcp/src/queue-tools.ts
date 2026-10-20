import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RouterClient } from "@orpc/server";
import type router from "@reactive-resume/api/routers";
import { queueDto } from "@reactive-resume/api/dto/capture";
import { MCP_TOOL_NAME as T } from "./mcp-tool-names";
import { queueActionInput } from "./queue-tool-meta";
import { json, withErrorHandling } from "./results";
import { TOOL_META } from "./tool-meta";

export function registerQueueTools(server: McpServer, client: RouterClient<typeof router>) {
	server.registerTool(
		T.listTailoringQueue,
		TOOL_META[T.listTailoringQueue],
		withErrorHandling("listing tailoring queue", async (params) =>
			json(await client.applications.queue.list(queueDto.list.input.parse(params))),
		),
	);
	server.registerTool(
		T.readTailoringQueueJob,
		TOOL_META[T.readTailoringQueueJob],
		withErrorHandling("reading queued job", async (params) =>
			json(await client.applications.queue.read(queueDto.read.input.parse(params))),
		),
	);
	server.registerTool(
		T.claimQueueJob,
		TOOL_META[T.claimQueueJob],
		withErrorHandling("claiming queued job", async (params) =>
			json(await client.applications.queue.claim(queueDto.claim.input.parse(params))),
		),
	);
	server.registerTool(
		T.updateQueueJob,
		TOOL_META[T.updateQueueJob],
		withErrorHandling("updating queued job", async (params) =>
			json(await client.applications.queue.update(queueDto.update.input.parse(params))),
		),
	);
	server.registerTool(
		T.finishQueueJob,
		TOOL_META[T.finishQueueJob],
		withErrorHandling("finishing queued job", async (params) =>
			json(await client.applications.queue.finish(queueDto.finish.input.parse(params))),
		),
	);
	server.registerTool(
		T.skipQueueJob,
		TOOL_META[T.skipQueueJob],
		withErrorHandling("skipping queued job", async (params) =>
			json(await client.applications.queue.action({ ...queueActionInput.parse(params), action: "skip" })),
		),
	);
	server.registerTool(
		T.requeueJob,
		TOOL_META[T.requeueJob],
		withErrorHandling("requeuing job", async (params) =>
			json(await client.applications.queue.action({ ...queueActionInput.parse(params), action: "requeue" })),
		),
	);
}
