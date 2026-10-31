import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, chmod, lstat, rm, open } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { QueueError } from "./mcp-client.mjs";

export const digest = (value) => createHash("sha256").update(value).digest("hex");

export async function readContextFile(path, label) {
	const info = await lstat(path);
	if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new QueueError("configuration", `${label} must be a text file no larger than 2 MiB.`);
	let text;
	try { text = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path)); } catch {
		throw new QueueError("configuration", `${label} must be UTF-8 text, Markdown, or a plain-text Google Doc export.`);
	}
	if (!text.trim()) throw new QueueError("configuration", `${label} is empty. Supply the real context before starting.`);
	return { text, sha256: digest(text), path: resolve(path) };
}

export async function atomicPrivateWrite(path, value) {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		const handle = await open(temporary, "wx", 0o600);
		try { await handle.writeFile(typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
		await rename(temporary, path);
		await chmod(path, 0o600);
	} finally { await rm(temporary, { force: true }); }
}

export async function ensurePrivateDirectory(path) {
	await mkdir(path, { recursive: true, mode: 0o700 });
	const info = await lstat(path);
	if (!info.isDirectory() || info.isSymbolicLink()) throw new QueueError("configuration", "Run state must be a real directory, not a symbolic link.");
	await chmod(path, 0o700);
}

export async function lockRun(directory, { pid = process.pid, host = hostname(), isAlive = processAlive } = {}) {
	const path = join(directory, "runner.lock");
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const handle = await open(path, "wx", 0o600);
			await handle.writeFile(JSON.stringify({ pid, host }));
			await handle.close();
			return async () => { await rm(path, { force: true }); };
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
			let previous;
			try { previous = JSON.parse(await readFile(path, "utf8")); } catch { throw new QueueError("locked", "Run lock is unreadable; verify no runner is active before removing runner.lock."); }
			if (previous.host !== host || !Number.isInteger(previous.pid) || isAlive(previous.pid)) {
				throw new QueueError("locked", "This run already has an active runner, or a lock from another machine.");
			}
			await rm(path);
		}
	}
	throw new QueueError("locked", "Could not acquire the run lock.");
}

function processAlive(pid) {
	try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}

export function assertPinnedContext(state, settings, background, instructions) {
	if (state.version !== 1 || state.backgroundSha256 !== background.sha256 || state.instructionsSha256 !== instructions.sha256) {
		throw new QueueError("context_changed", "Background or instructions changed. Start a new state directory so this batch keeps a consistent source snapshot.");
	}
	for (const key of ["url", "model", "effort", "baseResumeId"]) {
		if (settings[key] !== state.settings[key]) throw new QueueError("context_changed", `The ${key} setting differs from the saved run.`);
	}
}

export const jobDirectory = (stateDirectory, applicationId) => join(stateDirectory, `job-${digest(applicationId).slice(0, 24)}`);
