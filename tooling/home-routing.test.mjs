import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
import { beforeEach, test } from "node:test";
import { runInNewContext, SourceTextModule, SyntheticModule } from "node:vm";

const serverUrl = new URL("../apps/server/src/static/web.ts", import.meta.url);
const env = { APP_URL: "https://resume.example", ROOT_RESUME_ID: undefined };
const filesRead = [];
const shell = '<html><head><title>App</title><meta name="description" content="App"></head><body></body></html>';
const imports = {
	"node:fs": { existsSync: () => true },
	"node:fs/promises": { default: { readFile: async (path) => { filesRead.push(path); return shell; } } },
	"node:url": { fileURLToPath },
	"@hono/node-server/serve-static": { serveStatic: () => undefined },
	"@reactive-resume/env/server": { env },
	"@reactive-resume/schema/templates": { templateSchema: { options: [] } },
	"@reactive-resume/utils/locale": {
		defaultLocale: "en-US", getLocaleAlternates: () => [], isLocale: (value) => value === "en-US",
		localizedUrl: (url, locale) => `${url}?locale=${locale}`,
	},
};
const server = new SourceTextModule(stripTypeScriptTypes(await readFile(serverUrl, "utf8")), {
	identifier: serverUrl.href,
	initializeImportMeta: (meta) => { meta.url = serverUrl.href; },
});
await server.link((specifier) => {
	const values = imports[specifier];
	assert.ok(values, `Unexpected server dependency: ${specifier}`);
	return new SyntheticModule(Object.keys(values), function () {
		for (const [name, value] of Object.entries(values)) this.setExport(name, value);
	});
});
await server.evaluate();
const { handleWebApp } = server.namespace;

const routeSource = await readFile(new URL("../apps/web/src/routes/_home/index.tsx", import.meta.url), "utf8");
const loaderSource = routeSource.match(/loader: (async \(\{ context \}\) => \{[\s\S]*?\n\t\}),/u)?.[1];
assert.ok(loaderSource, "Exercise the actual client root-route loader.");
const loader = runInNewContext(`(${loaderSource})`, {
	orpc: { resume: { getRoot: { queryOptions: (options) => options } } },
	redirect: (options) => Object.assign(new Error("Redirect"), options),
});
const contextFor = (root) => ({ queryClient: { fetchQuery: async () => root } });

beforeEach(() => { env.ROOT_RESUME_ID = undefined; filesRead.length = 0; });

test("GET and HEAD root visits redirect to the dashboard before any HTML is read", async () => {
	for (const method of ["GET", "HEAD"]) {
		const response = await handleWebApp(new Request("https://resume.example/?callbackURL=https://other.example", { method }));
		assert.equal(response.status, 302);
		assert.equal(response.headers.get("Location"), "/dashboard");
		assert.equal(response.headers.get("Cache-Control"), "no-store");
		assert.equal(response.headers.get("X-Robots-Tag"), "noindex, follow");
		assert.equal(await response.text(), "");
	}
	assert.equal(filesRead.length, 0);
});

test("a configured public root resume keeps its existing shell and HEAD behavior", async () => {
	env.ROOT_RESUME_ID = "public-resume-id";
	for (const method of ["GET", "HEAD"]) {
		const response = await handleWebApp(new Request("https://resume.example/", { method }));
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("Location"), null);
		assert.equal(response.headers.get("Cache-Control"), "private, no-store");
		const text = await response.text();
		if (method === "GET") assert.match(text, /data-root-resume-shell/u);
		else assert.equal(text, "");
		assert.doesNotMatch(text, /public-resume-id/u);
	}
});

test("dashboard, login and editor paths still serve the application shell", async () => {
	for (const pathname of ["/dashboard", "/auth/login", "/builder/resume-1"]) {
		const response = await handleWebApp(new Request(`https://resume.example${pathname}`));
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("Location"), null);
		assert.equal(await response.text(), shell);
	}
});

test("SPA navigation to root redirects to dashboard when no public root resume is configured", async () => {
	await assert.rejects(loader({ context: contextFor({ status: "disabled" }) }), (error) => {
		assert.equal(error.to, "/dashboard");
		assert.equal(error.replace, true);
		return true;
	});
});

test("SPA navigation preserves configured public and unavailable root-resume results", async () => {
	for (const root of [{ status: "public", resume: { id: "public-resume" } }, { status: "unavailable" }]) {
		assert.equal((await loader({ context: contextFor(root) })).root, root);
	}
});
