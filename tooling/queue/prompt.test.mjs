import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const promptSource = await readFile(
	new URL("../../apps/web/src/features/applications/queue-prompt.ts", import.meta.url),
	"utf8",
);
const CLAUDE_QUEUE_PROMPT = runInNewContext(
	`${promptSource.replace("export const CLAUDE_QUEUE_PROMPT", "const CLAUDE_QUEUE_PROMPT")}\nCLAUDE_QUEUE_PROMPT`,
);
const source = await readFile(
	new URL("../../apps/web/src/features/applications/queue-view.tsx", import.meta.url),
	"utf8",
);
const handler = source.match(/const copyPrompt = (async \(\) => \{[\s\S]*?\n\t\});/u)?.[1];
assert.ok(handler, "The queue's clipboard handler must be exercised.");

function copyHandler(writeText, notifications) {
	return runInNewContext(`(${handler})`, {
		CLAUDE_QUEUE_PROMPT,
		navigator: { clipboard: { writeText } },
		toast: { add: (notification) => notifications.push(notification) },
		// Lingui production builds omit source-message fallbacks. With no catalog
		// entry, these two prompt paragraphs previously copied uV16ut and Zrk4ge.
		t: (strings) => createHash("sha256").update(`${strings.join("")}\u001f`).digest("base64").slice(0, 6),
	});
}

test("Copy Claude prompt writes readable workflow text without translation catalog entries", async () => {
	const copied = [];
	const notifications = [];
	await copyHandler(async (text) => copied.push(text), notifications)();
	assert.equal(copied.length, 1);
	const text = copied[0];
	assert.equal(text, CLAUDE_QUEUE_PROMPT);
	assert.ok(text.startsWith("Process my Reactive Resume queue"));
	assert.ok(text.length > 2500);
	assert.match(text, /Google Doc is the authoritative record/u);
	assert.match(text, /prepare_queued_resume/u);
	assert.match(text, /finalize=false/u);
	assert.match(text, /finalize=true/u);
	assert.match(text, /expectedPageCount=1/u);
	assert.match(text, /\n\nFinal requirement: the compiled resume must fit on exactly one page/u);
	assert.doesNotMatch(text, /uV16ut|Zrk4ge/u);
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].type, "success");
});

test("Copy Claude prompt reports clipboard rejection without claiming success", async () => {
	const notifications = [];
	await copyHandler(async () => {
		throw new Error("Clipboard permission denied");
	}, notifications)();
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].type, "error");
});
