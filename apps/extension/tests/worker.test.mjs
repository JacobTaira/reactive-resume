import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// Exercises the actual service worker across independent worker lifetimes.
// Chrome APIs and HTTP are test doubles; real Chrome permissions remain manual QA.
const ROOT = fileURLToPath(new URL("../src", import.meta.url));
const clone = value => structuredClone(value);
function chromeMock(storage) {
	const listeners = {},
		badges = [];
	const event = name => ({
		addListener: fn => {
			listeners[name] = fn;
		}
	});
	const chrome = {
		storage: {
			local: {
				setAccessLevel: async value => {
					assert.equal(value.accessLevel, "TRUSTED_CONTEXTS");
				},
				get: async keys => {
					if (typeof keys === "string") return {
						[keys]: clone(storage[keys])
					};
					return Object.fromEntries(Object.entries(keys).map(([key, value]) => [key, clone(storage[key] ?? value)]));
				},
				set: async data => {
					Object.assign(storage, clone(data));
				}
			}
		},
		action: {
			setBadgeBackgroundColor: async () => {},
			setBadgeText: async ({
				text
			}) => badges.push(text),
			onClicked: event("clicked")
		},
		runtime: {
			id: "fixture",
			getURL: path => "chrome-extension://fixture/" + path,
			openOptionsPage: async () => {},
			onInstalled: event("installed"),
			onStartup: event("startup"),
			onMessage: event("message")
		},
		commands: {
			onCommand: event("command")
		},
		alarms: {
			get: async () => ({}),
			create: async () => {},
			onAlarm: event("alarm")
		},
		permissions: {
			contains: async () => true
		}
	};
	return {
		chrome,
		listeners,
		badges
	};
}
async function worker(storage, fetch) {
	const mock = chromeMock(storage);
	const context = vm.createContext({
		chrome: mock.chrome,
		fetch,
		URL,
		AbortSignal,
		TextEncoder,
		setTimeout,
		crypto: globalThis.crypto,
		console
	});
	const modules = new Map();
	async function load(filename) {
		if (modules.has(filename)) return modules.get(filename);
		const module = new vm.SourceTextModule(fs.readFileSync(filename, "utf8"), {
			context,
			identifier: filename
		});
		modules.set(filename, module);
		await module.link(specifier => load(path.resolve(path.dirname(filename), specifier)));
		return module;
	}
	const module = await load(path.join(ROOT, "background.js"));
	await module.evaluate();
	async function message(value, sender = {
		id: "fixture",
		url: "chrome-extension://fixture/options.html",
		tab: { id: 2, url: "chrome-extension://fixture/options.html" }
	}) {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("Message did not respond")), 2000);
			mock.listeners.message(value, sender, response => {
				clearTimeout(timeout);
				response.ok ? resolve(response.data) : reject(new Error(response.error));
			});
		});
	}
	return {
		...mock,
		message
	};
}
async function until(predicate, timeout = 500) {
	for (let n = 0; n < timeout / 5; n++) {
		if (predicate()) return;
		await new Promise(resolve => setTimeout(resolve, 5));
	}
	throw new Error("Timed out waiting for worker outcome");
}
const payload = {
	url: "https://jobright.ai/jobs/info/fixture",
	canonicalUrl: "https://jobright.ai/jobs/info/fixture",
	company: "Example",
	role: "Engineer",
	description: "Complete fictional job description with requirements for building tested systems.",
	extraction: "jsonld",
	capturedAt: "2026-10-19T03:10:00Z"
};
const sender = {
	tab: {
		id: 1,
		url: payload.url
	},
	url: payload.url
};
const config = {
	baseUrl: "http://localhost:3000",
	apiKey: "fictional-capture-key"
};
function serverResponse(body, result = "created") {
	const resultBody = {
		results: body.items.map((item, index) => ({
			index,
			clientCaptureId: item.clientCaptureId,
			result: {
				id: "application-1",
				result,
				appUrl: "http://localhost:3000/dashboard/applications?applicationId=application-1",
				state: "pending",
				applicationStatus: "saved",
				warnings: []
			}
		}))
	};
	return {
		ok: true,
		status: 200,
		json: async () => resultBody
	};
}
test("settings opened in a browser tab can save configuration and test the connection", async () => {
	const storage = {};
	const calls = [];
	const instance = await worker(storage, async (url, options) => {
		calls.push({ url, options });
		return { ok: true, status: 200, json: async () => ({ connected: true, captureAllowed: true, version: 1 }) };
	});
	await instance.message({ type: "configure", ...config });
	assert.deepEqual(storage.config, config);
	const result = await instance.message({ type: "test" });
	assert.equal(result.connected, true);
	assert.equal(result.captureAllowed, true);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, `${config.baseUrl}/api/openapi/applications/capture/status`);
	assert.equal(calls[0].options.headers["x-api-key"], config.apiKey);
	assert.equal(calls[0].options.credentials, "omit");
});
test("settings access rejects other extensions, web pages and lookalike extension paths", async () => {
	const storage = { config };
	const instance = await worker(storage, async () => { throw new Error("No request expected"); });
	const senders = [
		{ id: "different", url: "chrome-extension://fixture/options.html" },
		{ id: "fixture", url: "chrome-extension://different/options.html" },
		{ id: "fixture", url: "https://example.com/options.html" },
		{ id: "fixture", url: "chrome-extension://fixture/options.html/lookalike" },
		{ id: "fixture", url: "chrome-extension://fixture/tests/extractor-browser.html" },
		{ url: "chrome-extension://fixture/options.html" },
	];
	for (const sender of senders) {
		for (const type of ["state", "configure", "test"]) {
			await assert.rejects(instance.message({ type, ...config }, sender), /only in extension settings/);
		}
	}
	assert.deepEqual(storage.config, config);
});
test("toolbar capture waits for Jobright content and sends the completed description once", async () => {
	const storage = { config };
	const uploaded = [];
	const instance = await worker(storage, async (_url, options) => {
		const body = JSON.parse(options.body);
		uploaded.push(...body.items);
		return serverResponse(body);
	});
	let extractions = 0;
	instance.chrome.scripting = { executeScript: async (request) => {
		if (request.files) return [];
		extractions++;
		return [{ result: extractions === 1 ? { ...payload, description: "", descriptionIncomplete: true } : payload }];
	} };
	instance.listeners.clicked({ id: 1, url: payload.url });
	await until(() => storage.outbox?.[0]?.status === "saved", 2500);
	assert.equal(extractions, 2);
	assert.equal(uploaded.length, 1);
	assert.equal(uploaded[0].description, payload.description);
});
test("toolbar capture aborts if the tab navigates to a different posting", async () => {
	const storage = { config };
	let calls = 0;
	const instance = await worker(storage, async () => { calls++; throw new Error("No upload expected"); });
	instance.chrome.scripting = { executeScript: async (request) => request.files ? []
		: [{ result: { ...payload, url: "https://jobright.ai/jobs/info/different" } }] };
	instance.listeners.clicked({ id: 1, url: payload.url });
	await until(() => Boolean(storage.lastError));
	assert.match(storage.lastError, /posting changed during capture/);
	assert.equal(storage.outbox, undefined);
	assert.equal(calls, 0);
});
test("actual worker saves locally before configuration and preserves pending data across restart", async () => {
	const storage = {};
	let calls = 0;
	const first = await worker(storage, async () => {
		calls++;
		throw new Error("Should not call network");
	});
	const captured = await first.message({
		type: "capture",
		payload
	}, sender);
	assert.equal(captured.status, "waiting");
	assert.equal(storage.outbox.length, 1);
	assert.equal(calls, 0);
	assert.equal(storage.outbox[0].body.description, payload.description);
	const second = await worker(storage, async () => {
		calls++;
		throw new Error("Should not call network");
	});
	const state = await second.message({
		type: "state"
	});
	assert.equal(state.outbox.length, 1);
	assert.equal(state.outbox[0].status, "waiting");
	assert.equal(state.configured, false);
	assert.equal(calls, 0);
});
test("actual worker retries response loss after restart and confirms existing application without cookie leakage", async () => {
	const storage = {
		config
	};
	let serverRecord = false,
		calls = 0;
	const fetch = async (url, options) => {
		calls++;
		assert.equal(url, "http://localhost:3000/api/openapi/applications/capture/batch");
		assert.equal(options.credentials, "omit");
		assert.equal(options.redirect, "error");
		assert.equal(options.headers["x-api-key"], config.apiKey);
		assert.equal("Cookie" in options.headers, false);
		const body = JSON.parse(options.body);
		assert.equal(body.items[0].description, payload.description);
		if (!serverRecord) {
			serverRecord = true;
			throw new Error("Response lost after server commit");
		}
		return serverResponse(body, "duplicate");
	};
	const first = await worker(storage, fetch);
	await first.message({
		type: "capture",
		payload
	}, sender);
	await until(() => storage.outbox?.[0]?.attempts === 1);
	assert.equal(storage.outbox[0].status, "waiting");
	assert.equal(storage.outbox[0].body.description, payload.description);
	storage.outbox[0].nextAttemptAt = 0;
	await worker(storage, fetch);
	await until(() => storage.outbox[0].status === "saved");
	assert.equal(serverRecord, true);
	assert.equal(calls, 2);
	assert.equal(storage.outbox[0].result.result, "duplicate");
	assert.equal(storage.outbox[0].result.id, "application-1");
});
test("capture content scripts cannot retrieve API key or perform settings actions", async () => {
	const storage = {
		config
	};
	const subject = await worker(storage, async () => {
		throw new Error("No network");
	});
	for (const type of ["state", "configure", "test", "sync"]) await assert.rejects(subject.message({
		type
	}, sender), /only in extension settings/);
	const state = await subject.message({
		type: "state"
	});
	assert.equal("apiKey" in state, false);
	assert.equal("config" in state, false);
});
test("one rejected capture does not prevent a valid batch sibling from syncing", async () => {
	const storage = {};
	const offline = await worker(storage, async () => {
		throw new Error("No configured installation");
	});
	await offline.message({
		type: "capture",
		payload
	}, sender);
	await offline.message({
		type: "capture",
		payload: {
			...payload,
			url: "https://jobright.ai/jobs/info/second",
			canonicalUrl: "https://jobright.ai/jobs/info/second"
		}
	}, sender);
	storage.config = config;
	await worker(storage, async () => ({
		ok: true,
		status: 200,
		json: async () => ({
			results: [{
				index: 0,
				error: {
					code: "INVALID_INPUT",
					message: "One malformed capture"
				}
			}, {
				index: 1,
				result: {
					id: "application-2",
					result: "created",
					appUrl: "http://localhost:3000/dashboard/applications?applicationId=application-2",
					state: "pending",
					applicationStatus: "saved",
					warnings: []
				}
			}]
		})
	}));
	await until(() => storage.outbox[0].status === "failed" && storage.outbox[1].status === "saved");
	assert.equal(storage.outbox[0].body.description, payload.description);
	assert.equal(storage.outbox[1].result.id, "application-2");
});
test("in-flight bulk progress cannot undo an explicit pause", async () => {
	const storage = {};
	const subject = await worker(storage, async () => {
		throw new Error("No network expected");
	});
	const bulk = {
		id: "bulk-1",
		items: [],
		phase: "collecting",
		canceled: false
	};
	await subject.message({
		type: "bulk-state",
		bulk
	}, sender);
	await subject.message({
		type: "bulk-cancel"
	});
	await subject.message({
		type: "bulk-state",
		bulk: {
			...bulk,
			phase: "capturing"
		}
	}, sender);
	assert.equal(storage.bulk.canceled, true);
	assert.equal(storage.bulk.phase, "paused");
	await subject.message({
		type: "bulk-state",
		bulk,
		resume: true
	}, sender);
	assert.equal(storage.bulk.canceled, false);
});
test("progress from an old tab cannot replace a newer bulk run", async () => {
	const storage = {};
	const subject = await worker(storage, async () => {
		throw new Error("No network expected");
	});
	const first = {
		id: "bulk-old",
		items: [],
		phase: "collecting",
		canceled: false
	};
	const second = {
		...first,
		id: "bulk-new"
	};
	await subject.message({
		type: "bulk-state",
		bulk: first,
		resume: true
	}, sender);
	await subject.message({
		type: "bulk-state",
		bulk: second,
		resume: true
	}, sender);
	await assert.rejects(subject.message({
		type: "bulk-state",
		bulk: {
			...first,
			phase: "paused"
		}
	}, sender), /older run is paused/i);
	assert.equal(storage.bulk.id, "bulk-new");
	assert.equal(storage.bulk.phase, "collecting");
});
