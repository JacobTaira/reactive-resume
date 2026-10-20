import { describe, expect, it } from "vitest";
import { canCapture, parseApiKeyPermissions } from "./credential-permissions";

describe("API-key permission isolation", () => {
	it("grants capture-only keys no general read, write, or delete permission", () => {
		const permissions = parseApiKeyPermissions({ api: ["capture"] });
		expect(permissions).toEqual(["capture"]);
		expect(canCapture(permissions)).toBe(true);
	});

	it("keeps legacy keys and explicit full keys compatible with capture", () => {
		for (const statements of [undefined, null, { api: ["read", "write", "delete"] }]) {
			const permissions = parseApiKeyPermissions(statements);
			expect(permissions).toEqual(["read", "write", "delete"]);
			expect(canCapture(permissions)).toBe(true);
		}
	});

	it("does not broaden malformed or unknown explicit permissions", () => {
		for (const statements of [{}, [], "capture", { api: "capture" }, { api: ["admin", "api:capture"] }]) {
			expect(parseApiKeyPermissions(statements)).toEqual([]);
		}
		expect(canCapture(parseApiKeyPermissions({ api: ["read"] }))).toBe(false);
	});
});
