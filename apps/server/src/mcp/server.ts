import type { RouterClient } from "@orpc/server";
import type { RequestAuthentication } from "@reactive-resume/api/context";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { onError } from "@orpc/client";
import { createRouterClient } from "@orpc/server";
import {
	buildMcpServerInfo,
	MCP_TOOL_NAME,
	MCP_ROUTER,
	registerParityTools,
	registerPrompts,
	registerResources,
	registerTools,
	registerToolDiscovery,
	TAILORING_PREFERENCES,
} from "@reactive-resume/mcp";
import { appVersion } from "../app-version";
import { getRequestLocale } from "../rpc/locale";

function createRequestClient(
	request: Request,
	authentication: RequestAuthentication,
	trustedClient: string,
	resHeaders: Headers,
): RouterClient<typeof MCP_ROUTER> {
	const reqHeaders = new Headers(request.headers);
	reqHeaders.delete("cookie");
	return createRouterClient(MCP_ROUTER, {
		interceptors: [
			(options) => {
				request.signal.throwIfAborted();
				return options.next({
					...options,
					signal: options.signal ? AbortSignal.any([request.signal, options.signal]) : request.signal,
				});
			},
			onError((error) => {
				console.error("[MCP oRPC]", { name: error instanceof Error ? error.name : "Unknown" });
			}),
		],
		context: () => ({
			locale: getRequestLocale(request),
			reqHeaders,
			resHeaders,
			trustedClient,
			authentication,
		}),
	});
}

export function createMcpServer(
	request: Request,
	authentication: RequestAuthentication,
	trustedClient: string,
	resHeaders: Headers,
) {
	const server = new McpServer(buildMcpServerInfo(appVersion), {
		instructions: [
			"Reactive Resume holds the user's resumes, cover letters and job applications.",
			TAILORING_PREFERENCES,
			`For queued LaTeX jobs: \`${MCP_TOOL_NAME.listTailoringQueue}\`, then \`${MCP_TOOL_NAME.prepareQueuedResume}\`, reason about numberedSource and section IDs, then \`${MCP_TOOL_NAME.finishQueuedResume}\` with sectionEdits/lineEdits. Delete sections by ID; send only final replacement text, never the old text being removed. Preamble, PDF metadata and header are locked; complete section removal includes its local spacing. These operations handle copying, linkage, claims, saved timestamps and server PDF checks.`,
			"Preparation includes compact related-resume references and saved company notes. Read another source only when its factual evidence is useful. Do not create local files, run local TeX, calculate checksums, fetch PDFs or write detailed metadata reports during this routine.",
			`For other document work, find unknown IDs with \`${MCP_TOOL_NAME.listResumes}\`, read LaTeX with \`${MCP_TOOL_NAME.readResumeLatex}\` and ordinary resumes with \`${MCP_TOOL_NAME.getResume}\`. The resume JSON Schema is the \`resume://_meta/schema\` resource.`,
			"Tools named api_* expose the rest of the Reactive Resume API. Tools that involve passwords, API keys or AI provider keys return a link to finish in the app.",
		].join(" "),
	});

	const client = createRequestClient(request, authentication, trustedClient, resHeaders);
	const headers = new Headers(request.headers);
	headers.delete("cookie");
	registerResources(server, client);
	registerTools(server, client, headers, authentication);
	registerParityTools(server, client, headers, {
		authentication,
		resHeaders,
		trustedClient,
		locale: getRequestLocale(request),
		signal: request.signal,
	});
	registerPrompts(server, client);
	registerToolDiscovery(server);

	return server;
}

