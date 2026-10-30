/** Small client for this installation's stateless JSON MCP transport. No third-party dependencies. */
export class QueueError extends Error {
	constructor(code, message, options = {}) {
		super(message, options);
		this.code = code;
		this.status = options.status;
		this.retryAfter = options.retryAfter;
	}
}

const READ_TOOLS = new Set([
	"list_tailoring_queue", "read_tailoring_queue_job", "read_resume", "read_resume_latex",
	"read_resume_metadata", "list_company_notes", "read_company_note", "find_related_resumes",
	"list_resumes",
]);

export function mcpEndpoint(value) {
	const url = new URL(value);
	const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && local))) {
		throw new QueueError("configuration", "Use an HTTPS installation URL, or HTTP on localhost, without credentials or query parameters.");
	}
	url.pathname = `${url.pathname.replace(/\/$/, "").replace(/\/mcp$/, "")}/mcp`;
	return url;
}

async function readBounded(response, limit) {
	if (!response.body) throw new QueueError("transport", "MCP returned no response body.");
	const reader = response.body.getReader();
	const chunks = [];
	let length = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > limit) throw new QueueError("transport", "MCP response exceeded the local size limit.");
			chunks.push(value);
		}
	} finally {
		await reader.cancel();
	}
	return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

export function parseRpcResponse(text, requestId) {
	let responses;
	try {
		responses = [JSON.parse(text)];
	} catch {
		responses = text.split(/\r?\n\r?\n/).flatMap((event) => {
			const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
			if (!data) return [];
			try { return [JSON.parse(data)]; } catch { return []; }
		});
	}
	const response = responses.find((item) => item && item.id === requestId);
	if (!response) throw new QueueError("transport", "MCP returned no matching JSON-RPC response.");
	if (response.error) throw new QueueError("rpc", "MCP rejected the request. Check the private run files and installation connection.");
	return response.result;
}

export class McpClient {
	constructor(url, apiKey, { fetchImpl = fetch, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
		this.url = mcpEndpoint(url);
		this.apiKey = apiKey;
		this.fetchImpl = fetchImpl;
		this.wait = wait;
		this.nextId = 0;
	}

	async request(method, params, { readOnly = false } = {}) {
		for (let attempt = 0; ; attempt++) {
			try {
				const id = ++this.nextId;
				const response = await this.fetchImpl(this.url, {
					method: "POST",
					headers: {
						"content-type": "application/json", accept: "application/json, text/event-stream",
						"x-api-key": this.apiKey, "mcp-protocol-version": "2025-03-26",
					},
					body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
					signal: AbortSignal.timeout(120_000), redirect: "error",
				});
				if (!response.ok) {
					const retry = response.headers.get("retry-after");
					throw new QueueError(response.status === 429 ? "rate_limit" : "http", `MCP request failed with HTTP ${response.status}.`, {
						status: response.status, retryAfter: retry && /^\d+$/.test(retry) ? Number(retry) : null,
					});
				}
				return parseRpcResponse(await readBounded(response, 12 * 1024 * 1024), id);
			} catch (error) {
				// Never automatically repeat mutations: a timed-out response can follow a committed write.
				if (readOnly && attempt < 2 && (!(error instanceof QueueError) || error.code === "transport" || error.status >= 500)) {
					await this.wait(1_000 * 2 ** attempt);
					continue;
				}
				if (error instanceof QueueError) throw error;
				throw new QueueError("transport", "MCP connection failed; saved state must be reconciled before retrying.", { cause: error });
			}
		}
	}

	async initialize() {
		await this.request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "reactive-resume-queue", version: "1.0.0" } }, { readOnly: true });
		return this.request("tools/list", {}, { readOnly: true });
	}

	async call(name, args = {}) {
		const result = await this.request("tools/call", { name, arguments: args }, { readOnly: READ_TOOLS.has(name) });
		if (result?.isError) {
			const details = result.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n") ?? "";
			if (/rate limit|too many requests/i.test(details)) throw new QueueError("rate_limit", "MCP tool reached a rate limit.");
			throw new QueueError("tool", `The ${name} tool failed. Inspect the saved application before retrying.`);
		}
		if (result?.structuredContent) return result.structuredContent;
		const text = result?.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n");
		try { return JSON.parse(text); } catch { throw new QueueError("protocol", `The ${name} tool returned no structured result.`); }
	}
}
