#!/usr/bin/env node
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, readdir, rm, chmod } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { McpClient, QueueError, mcpEndpoint } from "./mcp-client.mjs";
import { atomicPrivateWrite, assertPinnedContext, digest, ensurePrivateDirectory, jobDirectory, lockRun, readContextFile } from "./state.mjs";
import { runClaude, runProcess, reviewPrompt, validateReview, validateWriterResult, writerPrompt } from "./worker.mjs";

const HELP = `Prepare and independently review a resumable overnight resume batch.

New run:
  RR_API_KEY=... node tooling/queue/run.mjs --url http://localhost:3000 \\
    --model YOUR_CLAUDE_MODEL --ids application-id-1,application-id-2 \\
    --background /private/google-doc-export.txt --instructions /private/claude-instructions.txt \\
    --state-dir /private/resume-runs/tonight

Use --limit 30 instead of --ids to freeze the oldest pending/failed application IDs.
Resume:
  RR_API_KEY=... node tooling/queue/run.mjs --resume --state-dir /private/resume-runs/tonight \\
    --background /private/google-doc-export.txt --instructions /private/claude-instructions.txt

Required: Node 24+, authenticated official Claude Code CLI, pdftoppm (Poppler),
normal Reactive Resume API key in RR_API_KEY, and the updated local MCP service.
Google Doc access and Claude Project instructions do not transfer automatically.

Options:
  --base-resume-id ID       Explicit designated master; otherwise the server resolves it.
  --effort xhigh            Claude effort; default xhigh, pinned for the run.
  --cli PATH                Official Claude CLI executable; default claude.
  --renderer PATH           Poppler pdftoppm executable; default pdftoppm.
  --timeout-seconds N       Optional per-process operational timeout; default 0 (disabled).
  --resume                  Reconcile and continue unfinished jobs from this state directory.
  --help                    Print this help.

One job runs at a time. No resume-quality revision cap. You review and submit applications.
Private context, transcripts and artifacts remain in the protected state directory.
`;

export function parseArguments(argv) {
	const options = { effort: "xhigh", cli: "claude", renderer: "pdftoppm", timeoutSeconds: 0, resume: false };
	const names = {
		"--url": "url", "--model": "model", "--ids": "ids", "--limit": "limit",
		"--background": "background", "--instructions": "instructions", "--state-dir": "stateDirectory",
		"--base-resume-id": "baseResumeId", "--effort": "effort", "--cli": "cli", "--renderer": "renderer",
		"--timeout-seconds": "timeoutSeconds",
	};
	const supplied = new Set();
	for (let index = 0; index < argv.length; index++) {
		const key = argv[index];
		if (key === "--help") return { help: true };
		if (key === "--resume") { options.resume = true; continue; }
		if (!names[key] || supplied.has(key) || !argv[index + 1] || argv[index + 1].startsWith("--")) {
			throw new QueueError("configuration", `Invalid or repeated option: ${key}. Use --help.`);
		}
		supplied.add(key);
		options[names[key]] = argv[++index];
	}
	for (const key of ["background", "instructions", "stateDirectory"]) {
		if (!options[key]) throw new QueueError("configuration", `Missing --${key === "stateDirectory" ? "state-dir" : key}.`);
	}
	if (!options.resume && (!options.url || !options.model || Boolean(options.ids) === Boolean(options.limit))) {
		throw new QueueError("configuration", "New runs require --url, --model, and exactly one of --ids or --limit.");
	}
	if (options.resume && (options.ids || options.limit)) throw new QueueError("configuration", "A resumed run uses its pinned application IDs; do not supply --ids or --limit.");
	if (options.limit !== undefined && (!/^\d+$/.test(options.limit) || Number(options.limit) < 1 || Number(options.limit) > 1_000)) {
		throw new QueueError("configuration", "--limit must be between 1 and 1000.");
	}
	if (options.limit !== undefined) options.limit = Number(options.limit);
	if (!/^\d+$/.test(String(options.timeoutSeconds)) || Number(options.timeoutSeconds) > 7 * 24 * 60 * 60) {
		throw new QueueError("configuration", "--timeout-seconds must be a nonnegative integer (0 disables it).");
	}
	options.timeoutSeconds = Number(options.timeoutSeconds);
	if (!["low", "medium", "high", "xhigh", "max"].includes(options.effort)) throw new QueueError("configuration", "Unknown Claude effort setting.");
	if (options.ids) {
		options.ids = [...new Set(options.ids.split(",").map((id) => id.trim()).filter(Boolean))];
		if (!options.ids.length || options.ids.length > 1_000 || options.ids.some((id) => id.length > 300)) throw new QueueError("configuration", "Provide between 1 and 1000 application IDs.");
	}
	options.stateDirectory = resolve(options.stateDirectory);
	options.supplied = supplied;
	return options;
}

export async function selectApplicationIds(mcp, options) {
	if (options.ids) {
		for (const id of options.ids) await mcp.call("read_tailoring_queue_job", { id, includeDescription: false });
		return options.ids;
	}
	const selected = [];
	let offset = 0;
	while (selected.length < options.limit) {
		const result = await mcp.call("list_tailoring_queue", { states: ["pending", "failed"], includeDescription: false, limit: Math.min(100, options.limit - selected.length), offset });
		if (!Array.isArray(result.items)) throw new QueueError("protocol", "Queue listing returned no items.");
		for (const item of result.items) if (!selected.includes(item.id)) selected.push(item.id);
		if (result.nextOffset === null || !result.items.length) break;
		if (!Number.isInteger(result.nextOffset) || result.nextOffset <= offset) throw new QueueError("protocol", "Queue pagination did not advance.");
		offset = result.nextOffset;
	}
	return selected;
}

export async function resolveMaster(mcp, requestedId) {
	let id = requestedId;
	if (!id) {
		const matches = [];
		const names = new Set(["master_resume", "master resume", "base resume"]);
		for (let offset = 0; ; offset += 100) {
			const page = await mcp.call("list_resumes", { limit: 100, offset, sort: "name" });
			const items = page.items;
			if (!Array.isArray(items)) throw new QueueError("protocol", "Resume listing returned no items.");
			for (const item of items) if (names.has(item.name.trim().normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/g, " "))) matches.push(item.id);
			if (items.length < 100) break;
			if (offset >= 9_900) throw new QueueError("configuration", "Use --base-resume-id to select the master from this large collection.");
		}
		if (matches.length !== 1) throw new QueueError("configuration", "Select the intended master with --base-resume-id; the master name is missing or ambiguous.");
		id = matches[0];
	}
	const master = await currentDraft(mcp, id);
	if (!master.data?.latex) throw new QueueError("configuration", "This overnight runner requires a LaTeX master resume.");
	return master;
}

async function assertMasterSnapshot(mcp, snapshot) {
	if (!snapshot) return;
	const current = await currentDraft(mcp, snapshot.id);
	if (current.updatedAt !== snapshot.updatedAt || digest(JSON.stringify(current.data)) !== snapshot.sha256) {
		throw new QueueError("master_changed", "The designated master changed since this batch started. Start a new run to use the changed structure.");
	}
}

export function createHeartbeat(mcp, id, token, abort, { intervalMs = 30_000, now = Date.now } = {}) {
	let stopped = false;
	let pending = Promise.resolve();
	let failure;
	let ticking = false;
	const tick = async () => {
		if (stopped || ticking) return;
		ticking = true;
		try {
			const item = await mcp.call("read_tailoring_queue_job", { id, includeDescription: false });
			if (item.preparation.state !== "processing") throw new QueueError("ownership", "The queue job changed while a worker was active.");
			const expires = Date.parse(item.preparation.leaseExpiresAt);
			if (!Number.isFinite(expires)) throw new QueueError("ownership", "The active queue claim has no verified expiry.");
			// Finish/edit operations renew before compiling. Avoid revision churn during their normal work.
			if (expires - now() < 5 * 60_000) {
				await mcp.call("claim_queue_job", { id, expectedRevision: item.preparation.revision, leaseToken: token, leaseSeconds: 1800 });
			}
		} catch (error) { failure = error; abort.abort(error); } finally { ticking = false; }
	};
	const timer = setInterval(() => { pending = tick(); }, intervalMs);
	return {
		tick,
		check() { if (failure) throw failure; },
		async stop() { stopped = true; clearInterval(timer); await pending; if (failure) throw failure; },
	};
}

export function validateCompilation(result, timestamp) {
	if (!result.success || result.resumeUpdatedAt !== timestamp || result.checks?.pageCount !== 1 || result.checks?.pageCountMatches !== true ||
		result.checks?.textExtraction?.status !== "success" || !(result.checks.textExtraction.characterCount > 0)) {
		throw new QueueError("pdf_unverified", "The current saved resume did not pass one-page and extracted-text checks.");
	}
	return result.checks;
}

async function downloadPdf(url, installationOrigin, path, fetchImpl = fetch) {
	const target = new URL(url);
	if (target.origin !== installationOrigin || target.username || target.password) throw new QueueError("pdf", "The private PDF URL is outside this installation.");
	const response = await fetchImpl(target, { redirect: "error", signal: AbortSignal.timeout(120_000) });
	if (!response.ok || !response.body) throw new QueueError("pdf", "The saved resume PDF could not be downloaded.");
	const chunks = [];
	let size = 0;
	for await (const chunk of response.body) {
		size += chunk.byteLength;
		if (size > 16 * 1024 * 1024) throw new QueueError("pdf", "The resume PDF exceeded the local size limit.");
		chunks.push(chunk);
	}
	const bytes = Buffer.concat(chunks);
	if (bytes.subarray(0, 5).toString() !== "%PDF-") throw new QueueError("pdf", "The resume download was not a PDF.");
	// Buffer is intentionally written without JSON conversion.
	const { writeFile } = await import("node:fs/promises");
	await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
}

export async function renderDraft({ mcp, draft, directory, prefix, settings, signal }) {
	const compilation = await mcp.call("compile_resume_latex", { id: draft.id, expectedUpdatedAt: draft.updatedAt, expectedPageCount: 1 });
	await atomicPrivateWrite(join(directory, `${prefix}.compilation.json`), compilation);
	let checks;
	try { checks = validateCompilation(compilation, draft.updatedAt); } catch (error) {
		// Return actual diagnostics to drafting; missing diagnostics are never guessed into a passing result.
		if (compilation.success === false || compilation.checks?.pageCountMatches === false) {
			error.diagnostics = compilation;
		}
		throw error;
	}
	const download = await mcp.call("download_resume_pdf", { id: draft.id });
	const pdf = join(directory, `${prefix}.pdf`);
	await downloadPdf(download.downloadUrl, new URL(settings.url).origin, pdf);
	const imagePrefix = join(directory, `${prefix}.page`);
	const result = await runProcess(settings.renderer, ["-f", "1", "-singlefile", "-scale-to", "1800", "-png", pdf, imagePrefix], {
		directory, prefix: `${prefix}.render`, signal, timeoutSeconds: 120,
	});
	if (result.code !== 0) throw new QueueError("renderer", "The rendered PDF preview failed. The source and PDF remain saved.");
	const previewPath = `${imagePrefix}.png`;
	await chmod(previewPath, 0o600);
	return { checks, previewPath };
}

async function currentDraft(mcp, resumeId) {
	const draft = await mcp.call("read_resume", { id: resumeId, includeMetadata: true });
	if (draft.id !== resumeId || !draft.updatedAt) throw new QueueError("protocol", "The saved draft returned no current timestamp.");
	return draft;
}

async function releaseForAttention(mcp, id, token, reason, state = "failed") {
	const current = await mcp.call("read_tailoring_queue_job", { id, includeDescription: false });
	if (current.status === "saved" && current.preparation.state === "processing") {
		await mcp.call("update_queue_job", { id, expectedRevision: current.preparation.revision, leaseToken: token, state, notes: reason.slice(0, 4_900) });
	}
}

export async function processApplication({ mcp, state, entry, directory, background, systemFile, mcpConfig, save, signal, worker = runClaude, render = renderDraft, heartbeatOptions }) {
	const settings = state.settings;
	const initial = await mcp.call("read_tailoring_queue_job", { id: entry.id, includeDescription: true });
	if (initial.status !== "saved" || ["ready", "skipped", "needs_details"].includes(initial.preparation.state)) {
		entry.status = initial.status !== "saved" ? "outside_queue" : initial.preparation.state;
		await save();
		return;
	}
	await assertMasterSnapshot(mcp, state.master);
	if (initial.preparation.state === "processing" && !entry.leaseToken) throw new QueueError("ownership", "Another worker owns this queued job. Its claim was preserved.");
	entry.leaseToken ??= randomBytes(32).toString("hex");
	entry.status = "claiming";
	await save();
	await mcp.call("claim_queue_job", { id: entry.id, expectedRevision: initial.preparation.revision, leaseToken: entry.leaseToken, leaseSeconds: 1800 });
	entry.status = "preparing";
	await save();
	const prepared = await mcp.call("prepare_queued_resume", { applicationId: entry.id, leaseToken: entry.leaseToken, ...(settings.baseResumeId ? { baseResumeId: settings.baseResumeId } : {}) });
	if (prepared.applicationId !== entry.id || !prepared.draft?.id || prepared.leaseToken !== entry.leaseToken) throw new QueueError("protocol", "The prepared draft did not match this job and claim.");
	if (state.master && (prepared.base?.id !== state.master.id || prepared.base?.updatedAt !== state.master.updatedAt)) {
		throw new QueueError("master_changed", "The master changed while the draft was being prepared. The draft remains saved for review.");
	}
	entry.draftResumeId = prepared.draft.id;
	await atomicPrivateWrite(join(directory, `prepared-${randomUUID()}.json`), prepared);
	const abort = new AbortController();
	const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
	const heartbeat = createHeartbeat(mcp, entry.id, entry.leaseToken, abort, heartbeatOptions);
	let heartbeatStopped = false;
	let previous = entry.previousFindings ?? [];
	let lastUnchanged;
	try {
		for (let round = 1; ; round++) {
			heartbeat.check();
			const prefix = `attempt-${entry.attempts}-round-${round}-${randomUUID().slice(0, 8)}`;
			entry.status = "drafting";
			await save();
			const writerContext = round > 1 ? { ...prepared, draft: await currentDraft(mcp, prepared.draft.id) } : prepared;
			const writer = validateWriterResult(await worker({ ...settings, directory, prefix: `${prefix}.writer`, phase: "writer", mcpConfig, systemFile, signal: combined,
				prompt: writerPrompt({ job: initial, prepared: writerContext, background, previousFindings: previous }),
			}));
			if (writer.status === "needs_details") {
				await heartbeat.stop(); heartbeatStopped = true;
				await releaseForAttention(mcp, entry.id, entry.leaseToken, writer.notes.join("\n"), "needs_details");
				entry.status = "needs_details"; entry.notes = writer.notes; await save(); return;
			}
			const draft = await currentDraft(mcp, prepared.draft.id);
			entry.status = "reviewing";
			await save();
			let artifacts;
			try { artifacts = await render({ mcp, draft, directory, prefix, settings, signal: combined }); } catch (error) {
				if (error.code !== "pdf_unverified" || !error.diagnostics) throw error;
				previous = ["Correct the actual server PDF diagnostics before independent review.", JSON.stringify(error.diagnostics)];
				entry.previousFindings = previous;
				const unchanged = digest(JSON.stringify({ data: draft.data, findings: previous }));
				if (unchanged === lastUnchanged) throw new QueueError("no_progress", "The same PDF failure remains after an unchanged draft. Resume after resolving the saved diagnostics.");
				lastUnchanged = unchanged;
				await save();
				continue;
			}
			const evidence = validateReview(await worker({ ...settings, directory, prefix: `${prefix}.evidence`, phase: "evidence", mcpConfig, systemFile, signal: combined,
				prompt: reviewPrompt({ kind: "evidence", job: initial, draft, background, master: prepared.base.source ?? (prepared.base.sameSourceAsDraft ? prepared.draft : null) }),
			}), draft.updatedAt, false);
			const reader = validateReview(await worker({ ...settings, directory, prefix: `${prefix}.reader`, phase: "reader", mcpConfig, systemFile, previewPath: artifacts.previewPath, signal: combined,
				prompt: reviewPrompt({ kind: "reader", job: initial, draft, previewPath: artifacts.previewPath }),
			}), draft.updatedAt, true);
			if ((await currentDraft(mcp, draft.id)).updatedAt !== draft.updatedAt) throw new QueueError("stale_review", "The source changed during independent review; the draft was not finalized.");
			await atomicPrivateWrite(join(directory, `${prefix}.reviews.json`), { evidence, reader, reviewedResumeUpdatedAt: draft.updatedAt });
			heartbeat.check();
			if ([evidence, reader].some((review) => review.verdict === "needs_details")) {
				await heartbeat.stop(); heartbeatStopped = true;
				entry.notes = [...evidence.findings, ...reader.findings];
				await releaseForAttention(mcp, entry.id, entry.leaseToken, entry.notes.join("\n"), "needs_details");
				entry.status = "needs_details"; await save(); return;
			}
			if (evidence.verdict === "pass" && reader.verdict === "pass") {
				await heartbeat.stop(); heartbeatStopped = true;
				await assertMasterSnapshot(mcp, state.master);
				entry.status = "finalizing"; entry.reviewedResumeUpdatedAt = draft.updatedAt; await save();
				try {
					const finished = await mcp.call("finish_queued_resume", { applicationId: entry.id, leaseToken: entry.leaseToken, expectedUpdatedAt: draft.updatedAt, expectedPageCount: 1, finalize: true,
						notes: "Independent factual and hiring-reader reviews passed; the rendered page and extracted text were checked.",
					});
					if (!finished.success) throw new QueueError("completion", "Final server verification did not complete. Inspect current saved progress before resuming.");
				} catch (error) {
					// The final write might have committed even if its response was lost. Never replay edits.
					const reconciled = await mcp.call("read_tailoring_queue_job", { id: entry.id, includeDescription: false });
					if (reconciled.preparation.state !== "ready" || reconciled.preparation.draftResumeId !== draft.id) throw error;
				}
				const confirmed = await mcp.call("read_tailoring_queue_job", { id: entry.id, includeDescription: false });
				if (confirmed.preparation.state !== "ready" || confirmed.preparation.draftResumeId !== draft.id || (await currentDraft(mcp, draft.id)).updatedAt !== draft.updatedAt) {
					throw new QueueError("completion", "The final saved state did not match the reviewed draft.");
				}
				entry.status = "ready"; entry.completedAt = new Date().toISOString(); delete entry.previousFindings; delete entry.leaseToken; await save(); return;
			}
			previous = [...evidence.findings, ...reader.findings];
			entry.previousFindings = previous;
			const unchanged = digest(JSON.stringify({ data: draft.data, findings: previous }));
			if (unchanged === lastUnchanged) throw new QueueError("no_progress", "The same review concerns remain after an unchanged draft. Resume after resolving the saved findings.");
			lastUnchanged = unchanged;
			await save();
		}
	} finally {
		if (!heartbeatStopped) await heartbeat.stop();
	}
}

export async function runQueue({ mcp, state, stateDirectory, background, systemFile, mcpConfig, signal, worker, render, heartbeatOptions, log = console.log }) {
	const save = async () => { state.updatedAt = new Date().toISOString(); await atomicPrivateWrite(join(stateDirectory, "run.json"), state); };
	state.status = "running";
	await save();
	for (const entry of state.jobs) {
		if (signal?.aborted) { state.status = "interrupted"; await save(); return; }
		// A completed row is reconciled without rewriting or reapplying it.
		if (["ready", "outside_queue", "skipped"].includes(entry.status)) {
			const current = await mcp.call("read_tailoring_queue_job", { id: entry.id, includeDescription: false });
			if (entry.status === "ready" && current.status === "saved" && current.preparation.state !== "ready") {
				entry.status = "changed_after_completion"; await save();
			}
			continue;
		}
		const directory = jobDirectory(stateDirectory, entry.id);
		await ensurePrivateDirectory(directory);
		entry.attempts = (entry.attempts ?? 0) + 1;
		delete entry.error;
		try {
			await processApplication({ mcp, state, entry, directory, background, systemFile, mcpConfig, save, signal, ...(worker ? { worker } : {}), ...(render ? { render } : {}), ...(heartbeatOptions ? { heartbeatOptions } : {}) });
			log(`Job ${state.jobs.indexOf(entry) + 1}/${state.jobs.length}: ${entry.status}.`);
		} catch (error) {
			entry.status = signal?.aborted ? "interrupted" : error.code === "rate_limit" ? "paused" : "failed";
			entry.error = { code: error instanceof QueueError ? error.code : "unexpected", message: error instanceof QueueError ? error.message : "Unexpected failure; inspect private run files and saved application progress." };
			if (entry.leaseToken) {
				try { await releaseForAttention(mcp, entry.id, entry.leaseToken, entry.error.message); } catch { /* Uncertain ownership or connectivity is never overwritten. */ }
			}
			await save();
			log(`Job ${state.jobs.indexOf(entry) + 1}/${state.jobs.length}: ${entry.status} (${entry.error.code}).`);
			if (entry.status === "paused" || entry.status === "interrupted") { state.status = entry.status; await save(); return; }
			if (error.code === "master_changed") { state.status = "needs_attention"; await save(); return; }
		}
	}
	state.status = state.jobs.some((entry) => !["ready", "outside_queue", "skipped"].includes(entry.status)) ? "needs_attention" : "complete";
	await save();
	log(`Run ${state.status}. ${state.jobs.filter((entry) => entry.status === "ready").length}/${state.jobs.length} resumes ready for your review.`);
}

async function requireExecutable(command, args, label) {
	await new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, { stdio: "ignore" });
		const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new QueueError("configuration", `${label} did not respond to its version check.`)); }, 15_000);
		child.once("error", () => { clearTimeout(timer); reject(new QueueError("configuration", `${label} is unavailable. Install it before starting the queue.`)); });
		child.once("close", (code) => { clearTimeout(timer); if (code === 0) resolvePromise(); else reject(new QueueError("configuration", `${label} version check failed.`)); });
	});
}

export async function main(argv = process.argv.slice(2)) {
	const options = parseArguments(argv);
	if (options.help) { console.log(HELP); return; }
	// Validate the actual background and instructions before touching any queue entry.
	const [background, instructions] = await Promise.all([readContextFile(options.background, "Authoritative background"), readContextFile(options.instructions, "Claude instructions")]);
	let state;
	if (options.resume) {
		state = JSON.parse(await readFile(join(options.stateDirectory, "run.json"), "utf8"));
		options.url ??= state.settings.url;
		options.model ??= state.settings.model;
		options.baseResumeId ??= state.settings.baseResumeId;
		if (!options.supplied.has("--effort")) options.effort = state.settings.effort;
		if (!options.supplied.has("--cli")) options.cli = state.settings.cli;
		if (!options.supplied.has("--renderer")) options.renderer = state.settings.renderer;
		if (!options.supplied.has("--timeout-seconds")) options.timeoutSeconds = state.settings.timeoutSeconds;
	}
	const settings = { url: mcpEndpoint(options.url).href, model: options.model, effort: options.effort, baseResumeId: options.baseResumeId ?? null, cli: options.cli, renderer: options.renderer, timeoutSeconds: options.timeoutSeconds };
	if (state) assertPinnedContext(state, settings, background, instructions);
	if (state) state.settings = settings;
	const apiKey = process.env.RR_API_KEY;
	if (!apiKey?.trim()) throw new QueueError("configuration", "Set a normal Reactive Resume API key in RR_API_KEY; capture-only keys cannot prepare resumes.");
	await Promise.all([requireExecutable(settings.cli, ["--version"], "Claude Code CLI"), requireExecutable(settings.renderer, ["-v"], "Poppler pdftoppm")]);
	const mcp = new McpClient(settings.url, apiKey);
	const catalogue = await mcp.initialize();
	const requiredTools = ["claim_queue_job", "prepare_queued_resume", "finish_queued_resume", "edit_resume_latex", "compile_resume_latex", "download_resume_pdf", "read_resume"];
	if (requiredTools.some((name) => !catalogue.tools?.some((tool) => tool.name === name))) throw new QueueError("configuration", "The connected installation lacks required resume queue tools. Update it before running this batch.");
	const finalization = catalogue.tools.find((tool) => tool.name === "finish_queued_resume").inputSchema?.properties?.finalize;
	if (!finalization) throw new QueueError("configuration", "Update the queue tools before running: this runner requires explicit finalization support.");
	let master;
	if (!state) {
		try { if ((await readdir(options.stateDirectory)).length) throw new QueueError("configuration", "New runs require an empty state directory. Use --resume for an existing run."); } catch (error) { if (error.code !== "ENOENT") throw error; }
		const ids = await selectApplicationIds(mcp, options);
		if (!ids.length) throw new QueueError("configuration", "No pending or failed queue entries were selected.");
		master = await resolveMaster(mcp, settings.baseResumeId);
		settings.baseResumeId = master.id;
		state = { version: 1, runId: randomUUID(), createdAt: new Date().toISOString(), status: "new", settings, master: { id: master.id, updatedAt: master.updatedAt, sha256: digest(JSON.stringify(master.data)) }, backgroundSha256: background.sha256, instructionsSha256: instructions.sha256, jobs: ids.map((id) => ({ id, status: "pending", attempts: 0 })) };
	} else {
		if (!state.master) throw new QueueError("configuration", "This older run has no pinned master snapshot. Start a new state directory.");
		await assertMasterSnapshot(mcp, state.master);
	}
	await ensurePrivateDirectory(options.stateDirectory);
	const unlock = await lockRun(options.stateDirectory);
	const configPath = join(options.stateDirectory, `.mcp-private-${randomUUID()}.json`);
	const systemFile = join(options.stateDirectory, "instructions.txt");
	const abort = new AbortController();
	const interrupt = () => abort.abort(new QueueError("interrupted", "The runner was interrupted; saved drafts remain available."));
	process.once("SIGINT", interrupt);
	process.once("SIGTERM", interrupt);
	try {
		// A killed runner may leave its temporary MCP credential file. The exclusive run lock makes cleanup safe.
		for (const name of await readdir(options.stateDirectory)) {
			if (/^\.mcp-private-[0-9a-f-]+\.json$/.test(name)) await rm(join(options.stateDirectory, name), { force: true });
		}
		await atomicPrivateWrite(join(options.stateDirectory, "background.txt"), background.text);
		if (master) await atomicPrivateWrite(join(options.stateDirectory, "master.json"), master);
		await atomicPrivateWrite(systemFile, instructions.text);
		await atomicPrivateWrite(configPath, { mcpServers: { resume: { type: "http", url: settings.url, headers: { "x-api-key": apiKey } } } });
		await runQueue({ mcp, state, stateDirectory: options.stateDirectory, background: background.text, systemFile, mcpConfig: configPath, signal: abort.signal });
		if (state.status !== "complete") process.exitCode = 2;
	} finally {
		process.removeListener("SIGINT", interrupt);
		process.removeListener("SIGTERM", interrupt);
		await rm(configPath, { force: true });
		await unlock();
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	process.umask(0o077);
	main().catch((error) => {
		console.error(error instanceof QueueError ? error.message : "Runner failed. Inspect the private run directory and installation connection.");
		process.exitCode = 1;
	});
}
