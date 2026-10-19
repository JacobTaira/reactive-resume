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
			`Find unknown resume IDs with \`${MCP_TOOL_NAME.listResumes}\` or find_related_resumes, then read with \`${MCP_TOOL_NAME.getResume}\` (includeMetadata=true for tailoring). Reuse known owned IDs; no extra listing is required. The resume JSON Schema is the \`resume://_meta/schema\` resource.`,
			`For LaTeX prefer \`${MCP_TOOL_NAME.readResumeLatex}\` and small exact edits through \`${MCP_TOOL_NAME.editResumeLatex}\`; returned edit/compile timestamps avoid repeated whole-source reads. Use JSON Patch through \`${MCP_TOOL_NAME.patchResume}\` for ordinary resume content, and change names/tags/visibility with \`${MCP_TOOL_NAME.updateResume}\`.`,
			`Track jobs with the application tools. For queued jobs start with \`${MCP_TOOL_NAME.listTailoringQueue}\` and includeDescription=true; use \`${MCP_TOOL_NAME.listApplications}\` when general application discovery is needed.`,
			"Locate the user's designated Base Resume and read its full contents including LaTeX source. Related copies are references, not replacement base documents. Resume folders organize documents without changing access. Use company notes to retain sourced research, and keep saved fit scores separate from hiring predictions and optional chat output.",
			`Get a short-lived PDF link with \`${MCP_TOOL_NAME.downloadResumePdf}\`; export cover letters with \`${MCP_TOOL_NAME.exportCoverLetter}\`.`,
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

