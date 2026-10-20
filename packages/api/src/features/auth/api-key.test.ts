import { expect, it, vi } from "vitest";
import { createProcedureClient } from "@orpc/server";

const createApiKey = vi.hoisted(() => vi.fn());
vi.mock("@reactive-resume/auth/config", () => ({ auth: { api: { createApiKey } } }));
vi.mock("./service", () => ({ authService: {} }));
const { authRouter } = await import("./router");

it.each(["apiKey", "bearer", "session"] as const)(
	"requires a browser session to issue credentials: %s",
	async (method) => {
		createApiKey.mockReset().mockResolvedValue({ key: "issued-key" });
		const issue = createProcedureClient(authRouter.createApiKey, {
			context: {
				locale: "en-US",
				reqHeaders: new Headers(),
				authentication: {
					user: {
						id: "owner",
						name: "Owner",
						email: "owner@example.test",
						emailVerified: true,
						createdAt: new Date(),
						updatedAt: new Date(),
					},
					method,
					permissions: ["read", "write", "delete"],
				},
			},
		});
		const input = { name: "Read only", access: "read" as const, expiresIn: 86400 };
		if (method === "session") {
			await expect(issue(input)).resolves.toEqual({ key: "issued-key" });
			expect(createApiKey).toHaveBeenCalledWith({
				body: { userId: "owner", name: "Read only", expiresIn: 86400, permissions: { api: ["read"] } },
			});
		} else {
			await expect(issue(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(createApiKey).not.toHaveBeenCalled();
		}
	},
);

it("issues capture-only keys with no account read, write, or delete scope", async () => {
	createApiKey.mockReset().mockResolvedValue({ key: "capture-key" });
	const issue = createProcedureClient(authRouter.createApiKey, {
		context: {
			locale: "en-US",
			reqHeaders: new Headers(),
			authentication: {
				user: {
					id: "owner",
					name: "Owner",
					email: "owner@example.test",
					emailVerified: true,
					createdAt: new Date(),
					updatedAt: new Date(),
				},
				method: "session",
				permissions: ["read", "write", "delete"],
			},
		},
	});
	await expect(issue({ name: "Capture extension", access: "capture", expiresIn: 86400 })).resolves.toEqual({
		key: "capture-key",
	});
	expect(createApiKey).toHaveBeenCalledWith({
		body: { userId: "owner", name: "Capture extension", expiresIn: 86400, permissions: { api: ["capture"] } },
	});
});

it("denies credential issuance and account export to capture-only keys", async () => {
	createApiKey.mockReset();
	const context = {
		locale: "en-US" as const,
		reqHeaders: new Headers({ "x-api-key": "capture-key" }),
		authentication: {
			user: {
				id: "owner",
				name: "Owner",
				email: "owner@example.test",
				emailVerified: true,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
			method: "apiKey" as const,
			permissions: ["capture" as const],
		},
	};
	const issue = createProcedureClient(authRouter.createApiKey, { context });
	const exportData = createProcedureClient(authRouter.exportData, { context });
	await expect(issue({ name: "Escalation", access: "full", expiresIn: null })).rejects.toMatchObject({
		code: "FORBIDDEN",
	});
	await expect(exportData(undefined)).rejects.toMatchObject({ code: "FORBIDDEN" });
	expect(createApiKey).not.toHaveBeenCalled();
});

