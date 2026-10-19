export type RequestPermission = "read" | "write" | "delete" | "capture";

export const fullPermissions: readonly RequestPermission[] = ["read", "write", "delete"];
const apiKeyPermissions: readonly RequestPermission[] = [...fullPermissions, "capture"];

/** Missing permissions predate scoped keys; an explicit empty object grants nothing. */
export function parseApiKeyPermissions(statements: unknown): readonly RequestPermission[] {
	if (statements == null) return fullPermissions;
	const api = typeof statements === "object" && "api" in statements ? statements.api : null;
	return apiKeyPermissions.filter((permission) => Array.isArray(api) && api.includes(permission));
}

/** Capture credentials never inherit general account access. Legacy write keys remain compatible. */
export function canCapture(permissions: readonly RequestPermission[]): boolean {
	return permissions.includes("capture") || permissions.includes("write");
}
