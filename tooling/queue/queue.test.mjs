import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpClient, QueueError, mcpEndpoint, parseRpcResponse } from "./mcp-client.mjs";
import { atomicPrivateWrite, assertPinnedContext, ensurePrivateDirectory, lockRun, readContextFile } from "./state.mjs";
import { createHeartbeat, main, parseArguments, resolveMaster, runQueue, selectApplicationIds, validateCompilation } from "./run.mjs";
import { parseClaudeResult, reviewPrompt, runProcess, validateReview, workerArguments } from "./worker.mjs";

async function temporary(callback) {
	const directory = await mkdtemp(join(tmpdir(), "resume-queue-test-"));
	try { return await callback(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

const goodChecks = { pageCount: 1, pageCountMatches: true, textExtraction: { status: "success", characterCount: 2400 } };
const initialTime = "2026-10-30T00:00:00.000Z";

function fixture(ids = ["job-1"]) {
	const records = new Map(ids.map((id) => [id, { id, status: "saved", company: "Example", role: "Engineer", description: "Build tested software.", preparation: { state: "pending", revision: 1, draftResumeId: null, leaseExpiresAt: null } }]));
	const draft = { id: "draft-1", updatedAt: initialTime, data: { latex: { files: [{ path: "main.tex", content: "original" }] } } };
	const calls = [];
	const events = [];
	let failFinishResponse = false;
	const mcp = {
		async call(name, args) {
			calls.push({ name, args }); events.push(name);
			const record = records.get(args.id ?? args.applicationId);
			if (name === "read_tailoring_queue_job") return structuredClone(record);
			if (name === "claim_queue_job") {
				assert.equal(args.expectedRevision, record.preparation.revision);
				if (record.preparation.state === "processing" && record.token !== args.leaseToken) throw new QueueError("tool", "Claim belongs to another worker.");
				record.token = args.leaseToken;
				record.preparation.state = "processing";
				record.preparation.revision++;
				record.preparation.leaseExpiresAt = new Date(Date.now() + 1_800_000).toISOString();
				return { item: structuredClone(record), leaseToken: record.token };
			}
			if (name === "prepare_queued_resume") {
				record.preparation.draftResumeId = draft.id;
				return { applicationId: record.id, leaseToken: record.token, job: structuredClone(record), draft: structuredClone(draft), base: { id: "master-1" } };
			}
			if (name === "read_resume") return structuredClone(draft);
			if (name === "finish_queued_resume") {
				assert.equal(args.expectedUpdatedAt, draft.updatedAt);
				assert.equal(args.finalize, true);
				assert.ok(events.includes("evidence-review")); assert.ok(events.includes("reader-review"));
				record.preparation.state = "ready";
				if (failFinishResponse) throw new QueueError("transport", "Response lost after commit.");
				return { success: true };
			}
			if (name === "update_queue_job") {
				assert.equal(args.leaseToken, record.token);
				assert.equal(args.expectedRevision, record.preparation.revision);
				record.preparation.state = args.state; record.preparation.notes = args.notes; record.preparation.revision++;
				return structuredClone(record);
			}
			throw new Error(`Unexpected fake tool: ${name}`);
		},
	};
	let rounds = 0;
	const worker = async ({ phase, prompt }) => {
		if (phase === "writer") {
			rounds++; events.push("writer");
			assert.ok(prompt.includes("AUTHORITATIVE GOOGLE DOC EXPORT"));
			draft.updatedAt = `2026-10-30T00:00:${String(rounds).padStart(2, "0")}.000Z`;
			draft.data.latex.files[0].content = `draft ${rounds}`;
			return { status: "drafted", notes: [] };
		}
		events.push(`${phase === "evidence" ? "evidence" : "reader"}-review`);
		if (phase === "reader") assert.ok(!prompt.includes("SECRET_BACKGROUND"));
		return { verdict: "pass", findings: [], reviewedResumeUpdatedAt: draft.updatedAt, visualInspection: phase === "reader" ? "performed" : "not_required" };
	};
	const state = { version: 1, settings: { model: "supported-model", effort: "xhigh", url: "http://localhost:3000/mcp", timeoutSeconds: 0 }, jobs: ids.map((id) => ({ id, status: "pending", attempts: 0 })) };
	return { mcp, records, draft, calls, events, worker, state, setLostFinish() { failFinishResponse = true; }, get rounds() { return rounds; } };
}

async function runFixture(f, directory, overrides = {}) {
	return runQueue({ mcp: f.mcp, state: f.state, stateDirectory: directory, background: "SECRET_BACKGROUND", systemFile: join(directory, "instructions.txt"), mcpConfig: join(directory, "mcp-private.json"), worker: f.worker,
		render: async () => ({ checks: goodChecks, previewPath: join(directory, "page.png") }), heartbeatOptions: { intervalMs: 1_000_000 }, log() {}, ...overrides });
}

test("CLI requires authoritative context and an explicit initial selection", () => {
	assert.throws(() => parseArguments(["--url", "http://localhost:3000", "--model", "opus", "--limit", "30"]), /background/);
	assert.throws(() => parseArguments(["--background", "facts.txt", "--instructions", "instructions.txt", "--state-dir", "run", "--url", "http://localhost:3000", "--model", "opus"]), /exactly one/);
	const args = parseArguments(["--background", "facts.txt", "--instructions", "instructions.txt", "--state-dir", "run", "--url", "http://localhost:3000", "--model", "opus", "--ids", "a,b,a"]);
	assert.deepEqual(args.ids, ["a", "b"]); assert.equal(args.effort, "xhigh"); assert.equal(args.timeoutSeconds, 0);
	assert.throws(() => parseArguments(["--resume", "--background", "x", "--instructions", "y", "--state-dir", "z", "--limit", "3"]), /pinned application IDs/);
});

test("missing background fails before a network request or queue mutation", async () => {
	const original = globalThis.fetch;
	let requests = 0;
	globalThis.fetch = async () => { requests++; throw new Error("must not run"); };
	try {
		await assert.rejects(main(["--background", "/does-not-exist/background.txt", "--instructions", "/does-not-exist/instructions.txt", "--state-dir", "/tmp/unused-resume-run", "--url", "http://localhost:3000", "--model", "opus", "--limit", "1"]));
		assert.equal(requests, 0);
	} finally { globalThis.fetch = original; }
});

test("private source snapshots reject empty and invalid UTF-8 context", async () => temporary(async (directory) => {
	const path = join(directory, "background.txt");
	await writeFile(path, "  \n"); await assert.rejects(readContextFile(path, "Background"), /empty/);
	await writeFile(path, Buffer.from([0xff, 0xfe])); await assert.rejects(readContextFile(path, "Background"), /UTF-8/);
	await writeFile(path, "Verified facts."); const source = await readContextFile(path, "Background");
	assert.equal(source.text, "Verified facts."); assert.equal(source.sha256.length, 64);
}));

test("state writes are atomic, private, and context/model settings remain pinned", async () => temporary(async (directory) => {
	await ensurePrivateDirectory(directory);
	const path = join(directory, "run.json"); await atomicPrivateWrite(path, { status: "pending" }); await atomicPrivateWrite(path, { status: "ready" });
	assert.equal(JSON.parse(await readFile(path, "utf8")).status, "ready");
	assert.equal((await stat(directory)).mode & 0o777, 0o700); assert.equal((await stat(path)).mode & 0o777, 0o600);
	const settings = { url: "http://localhost/mcp", model: "opus", effort: "xhigh", baseResumeId: null };
	const state = { version: 1, settings, backgroundSha256: "facts", instructionsSha256: "instructions" };
	assertPinnedContext(state, settings, { sha256: "facts" }, { sha256: "instructions" });
	assert.throws(() => assertPinnedContext(state, settings, { sha256: "new" }, { sha256: "instructions" }), /changed/);
	assert.throws(() => assertPinnedContext(state, { ...settings, model: "different" }, { sha256: "facts" }, { sha256: "instructions" }), /model/);
}));

test("a live lock is preserved and a provably stale same-host lock can recover", async () => temporary(async (directory) => {
	const unlock = await lockRun(directory, { pid: 100, host: "test-host", isAlive: () => true });
	await assert.rejects(lockRun(directory, { pid: 200, host: "test-host", isAlive: () => true }), /active runner/);
	await unlock();
	await writeFile(join(directory, "runner.lock"), JSON.stringify({ pid: 100, host: "test-host" }));
	const recovered = await lockRun(directory, { pid: 200, host: "test-host", isAlive: () => false }); await recovered();
}));

test("MCP accepts only HTTPS or local HTTP and parses JSON/SSE responses", () => {
	assert.equal(mcpEndpoint("http://localhost:3000/").href, "http://localhost:3000/mcp");
	assert.throws(() => mcpEndpoint("http://remote.example/mcp")); assert.throws(() => mcpEndpoint("https://secret@example.com"));
	assert.deepEqual(parseRpcResponse('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}', 1), { ok: true });
	assert.deepEqual(parseRpcResponse('event: message\ndata: {"id":1,"result":{"ok":true}}\n\n', 1), { ok: true });
	assert.throws(() => parseRpcResponse('{"id":2,"result":{}}', 1), /matching/);
});

test("MCP never blindly retries a failed mutation, but retries transient reads", async () => {
	let calls = 0;
	const mutation = new McpClient("http://localhost:3000", "private-key", { fetchImpl: async () => { calls++; throw new Error("lost response after commit"); }, wait: async () => {} });
	await assert.rejects(mutation.call("claim_queue_job", {}), /reconciled/); assert.equal(calls, 1);
	calls = 0;
	const read = new McpClient("http://localhost:3000", "private-key", { fetchImpl: async (_url, options) => {
		calls++; if (calls < 3) return new Response("temporary", { status: 503 });
		const request = JSON.parse(options.body); return Response.json({ id: request.id, result: { structuredContent: { id: "job" } } });
	}, wait: async () => {} });
	assert.equal((await read.call("read_tailoring_queue_job", {})).id, "job"); assert.equal(calls, 3);
});

test("queue selection freezes paginated IDs before state-changing work", async () => {
	const names = [];
	const ids = await selectApplicationIds({ async call(name, input) { names.push(name); return input.offset === 0 ? { items: [{ id: "a" }, { id: "b" }], nextOffset: 2 } : { items: [{ id: "c" }], nextOffset: null }; } }, { limit: 3 });
	assert.deepEqual(ids, ["a", "b", "c"]); assert.ok(names.every((name) => name === "list_tailoring_queue"));
});

test("master resolution pins the designated source and refuses name ambiguity before claiming", async () => {
	const calls = [];
	const mcp = { async call(name) {
		calls.push(name);
		return name === "list_resumes" ? { items: [{ id: "master", name: "Master_Resume" }] } : { id: "master", updatedAt: initialTime, data: { latex: { files: [] } } };
	} };
	assert.equal((await resolveMaster(mcp)).id, "master"); assert.ok(!calls.includes("claim_queue_job"));
	await assert.rejects(resolveMaster({ async call() { return { items: [{ id: "a", name: "Master_Resume" }, { id: "b", name: "Base Resume" }] }; } }), /ambiguous/);
});

test("heartbeat renews near expiry and aborts if ownership changes", async () => {
	let claim;
	const abort = new AbortController();
	const heartbeat = createHeartbeat({ async call(name, input) {
		if (name === "read_tailoring_queue_job") return { preparation: { state: "processing", revision: 7, leaseExpiresAt: new Date(120_000).toISOString() } };
		claim = input; return {};
	} }, "job", "lease", abort, { intervalMs: 1_000_000, now: () => 0 });
	await heartbeat.tick(); await heartbeat.stop(); assert.equal(claim.expectedRevision, 7); assert.equal(claim.leaseToken, "lease"); assert.equal(claim.leaseSeconds, 1800);
	const lost = createHeartbeat({ async call() { return { preparation: { state: "ready" } }; } }, "job", "lease", abort, { intervalMs: 1_000_000 });
	await lost.tick(); assert.equal(abort.signal.aborted, true); await assert.rejects(lost.stop(), /changed/);
});

test("worker permissions exclude finalization and provider-backed actions", () => {
	const args = workerArguments({ model: "opus", effort: "xhigh", mcpConfig: "/private/config.json", systemFile: "/private/instructions.txt", phase: "writer" });
	const allowed = args[args.indexOf("--allowedTools") + 1];
	assert.ok(allowed.includes("edit_resume_latex")); assert.ok(!allowed.includes("finish_queued_resume")); assert.ok(!allowed.includes("tailor_resume_for_application"));
	assert.equal(args[args.indexOf("--tools") + 1], ""); assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
	const reader = reviewPrompt({ kind: "reader", job: {}, draft: {}, background: "SECRET_SOURCE", previewPath: "/private/page.png" });
	assert.ok(!reader.includes("SECRET_SOURCE"));
	const blind = reviewPrompt({ kind: "reader", job: { preparation: { notes: "SECRET_WRITER_REASON" } }, draft: { id: "draft", data: {}, libraryMetadata: { score: 100, scoreNotes: "SECRET_WRITER_REASON" } }, previewPath: "/private/page.png" });
	assert.ok(!blind.includes("SECRET_WRITER_REASON")); assert.ok(!blind.includes("scoreNotes"));
});

test("review receipts require the current timestamp, resolved findings, and actual visual inspection", () => {
	assert.throws(() => validateReview({ verdict: "pass", findings: [], reviewedResumeUpdatedAt: "old", visualInspection: "performed" }, initialTime, true), /current/);
	assert.throws(() => validateReview({ verdict: "pass", findings: [], reviewedResumeUpdatedAt: initialTime, visualInspection: "unavailable" }, initialTime, true), /unavailable/);
	assert.throws(() => validateReview({ verdict: "pass", findings: ["unsupported"], reviewedResumeUpdatedAt: initialTime, visualInspection: "performed" }, initialTime, true), /unresolved/);
	assert.throws(() => validateCompilation({ success: true, resumeUpdatedAt: initialTime, checks: { ...goodChecks, pageCount: 2 } }, initialTime), /one-page/);
});

test("only independent passing reviews permit finalization and no submitted status is written", async () => temporary(async (directory) => {
	const f = fixture(); await runFixture(f, directory);
	assert.equal(f.state.status, "complete"); assert.equal(f.state.jobs[0].status, "ready");
	assert.ok(f.events.indexOf("finish_queued_resume") > f.events.indexOf("reader-review"));
	assert.ok(f.calls.every(({ name }) => !["update_application", "tailor_resume_for_application"].includes(name)));
	assert.equal(f.records.get("job-1").status, "saved"); assert.equal(f.state.jobs[0].leaseToken, undefined);
}));

test("a lost completion response is reconciled without replaying completion or edits", async () => temporary(async (directory) => {
	const f = fixture(); f.setLostFinish(); await runFixture(f, directory);
	assert.equal(f.state.jobs[0].status, "ready"); assert.equal(f.calls.filter(({ name }) => name === "finish_queued_resume").length, 1);
}));

test("material revisions can continue past a fixed one-repair limit", async () => temporary(async (directory) => {
	const f = fixture(); const original = f.worker;
	await runFixture(f, directory, { worker: async (input) => {
		const result = await original(input);
		return input.phase === "evidence" && f.rounds < 4 ? { ...result, verdict: "revise", findings: [`Improve evidence selection, pass ${f.rounds}.`] } : result;
	} });
	assert.equal(f.rounds, 4); assert.equal(f.state.jobs[0].status, "ready");
}));

test("actual PDF failures return to drafting before any reviewer can pass them", async () => temporary(async (directory) => {
	const f = fixture();
	await runFixture(f, directory, { render: async () => {
		if (f.rounds === 1) {
			const error = new QueueError("pdf_unverified", "Two pages.");
			error.diagnostics = { success: true, checks: { pageCount: 2, pageCountMatches: false } };
			throw error;
		}
		return { checks: goodChecks, previewPath: join(directory, "page.png") };
	} });
	assert.equal(f.rounds, 2); assert.equal(f.state.jobs[0].status, "ready");
	assert.equal(f.events.filter((event) => event === "evidence-review").length, 1);
}));

test("repeated concerns after unchanged source stop for attention without a false quality pass", async () => temporary(async (directory) => {
	const f = fixture(); const original = f.worker;
	await runFixture(f, directory, { worker: async (input) => {
		const result = await original(input);
		if (input.phase === "writer") f.draft.data.latex.files[0].content = "unchanged source";
		return input.phase === "evidence" ? { ...result, verdict: "revise", findings: ["Clarify the same unsupported scope."] } : result;
	} });
	assert.equal(f.rounds, 2); assert.equal(f.state.jobs[0].error.code, "no_progress");
	assert.ok(!f.calls.some(({ name }) => name === "finish_queued_resume"));
}));

test("failed visual review never marks a draft Ready", async () => temporary(async (directory) => {
	const f = fixture(); const original = f.worker;
	await runFixture(f, directory, { worker: async (input) => {
		const result = await original(input); return input.phase === "reader" ? { ...result, visualInspection: "unavailable" } : result;
	} });
	assert.equal(f.state.jobs[0].status, "failed"); assert.equal(f.state.jobs[0].error.code, "visual_unverified");
	assert.ok(!f.calls.some(({ name }) => name === "finish_queued_resume")); assert.equal(f.records.get("job-1").preparation.draftResumeId, "draft-1");
}));

test("usage limits pause the batch and preserve unfinished and unstarted work", async () => temporary(async (directory) => {
	const f = fixture(["job-1", "job-2"]);
	await runFixture(f, directory, { worker: async () => { throw new QueueError("rate_limit", "Claude usage paused."); } });
	assert.equal(f.state.status, "paused"); assert.equal(f.state.jobs[0].status, "paused"); assert.equal(f.state.jobs[1].status, "pending");
	assert.equal(f.records.get("job-1").preparation.draftResumeId, "draft-1"); assert.equal(f.records.get("job-2").preparation.state, "pending");
}));

test("a changed pinned master stops before claiming or editing a job", async () => temporary(async (directory) => {
	const f = fixture();
	f.state.master = { id: "draft-1", updatedAt: initialTime, sha256: "different-content" };
	await runFixture(f, directory);
	assert.equal(f.state.status, "needs_attention"); assert.equal(f.state.jobs[0].error.code, "master_changed");
	assert.ok(!f.calls.some(({ name }) => name === "claim_queue_job"));
}));

test("a source change during independent review prevents finalization", async () => temporary(async (directory) => {
	const f = fixture(); const original = f.worker;
	await runFixture(f, directory, { worker: async (input) => {
		const result = await original(input);
		if (input.phase === "reader") f.draft.updatedAt = "2026-10-30T01:00:00.000Z";
		return result;
	} });
	assert.equal(f.state.jobs[0].error.code, "stale_review"); assert.ok(!f.calls.some(({ name }) => name === "finish_queued_resume"));
}));

test("completed jobs are reconciled and preserved on resume", async () => temporary(async (directory) => {
	const f = fixture(); await runFixture(f, directory); const writes = f.calls.filter(({ name }) => name === "finish_queued_resume").length;
	await runFixture(f, directory); assert.equal(f.rounds, 1); assert.equal(f.calls.filter(({ name }) => name === "finish_queued_resume").length, writes);
}));

test("CLI failures and usage-limit envelopes are distinguished without displaying private output", () => {
	assert.throws(() => parseClaudeResult(JSON.stringify({ is_error: true, result: "You've hit your usage limit. Resets soon." }), 1), (error) => error.code === "rate_limit");
	assert.throws(() => parseClaudeResult(JSON.stringify({ is_error: true, result: "PRIVATE SOURCE TEXT" }), 1), (error) => error.code === "worker" && !error.message.includes("PRIVATE"));
	assert.deepEqual(parseClaudeResult(JSON.stringify({ type: "result", subtype: "success", structured_output: { status: "drafted", notes: [] } })), { status: "drafted", notes: [] });
});

test("process execution preserves actual newlines and private output files without a shell", async () => temporary(async (directory) => {
	const result = await runProcess(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { directory, prefix: "process", input: "first\nsecond $() `literal`\n" });
	assert.equal(result.code, 0); assert.equal(await readFile(result.outputPath, "utf8"), "first\nsecond $() `literal`\n");
	assert.equal((await stat(result.outputPath)).mode & 0o777, 0o600);
}));
