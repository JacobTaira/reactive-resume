import { describe, expect, it } from "vitest";
import { folderPaths } from "./folders";

describe("folderPaths", () => {
	it("resolves parents before children without relying on API order", () => {
		expect(
			folderPaths([
				{ id: "child", name: "Robotics", parentId: "parent" },
				{ id: "parent", name: "Jobs", parentId: null },
				{ id: "other", name: "Archive", parentId: null },
			]).map((folder) => folder.path),
		).toEqual(["Archive", "Jobs", "Jobs / Robotics"]);
	});

	it("keeps orphan folders navigable and terminates malformed cycles", () => {
		const paths = folderPaths([
			{ id: "orphan", name: "Imported", parentId: "missing" },
			{ id: "a", name: "A", parentId: "b" },
			{ id: "b", name: "B", parentId: "a" },
		]);
		expect(paths.find((folder) => folder.id === "orphan")?.path).toBe("Imported");
		expect(paths).toHaveLength(3);
		expect(paths.every((folder) => folder.path.length < 20)).toBe(true);
	});
});
