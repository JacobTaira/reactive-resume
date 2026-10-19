import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";

const dbMock = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock("@reactive-resume/db/client", () => ({ db: dbMock }));
const { compareResumes } = await import("./comparison");

const date = new Date("2026-10-19T00:00:00Z");
const row = (id: string, sourceResumeId: string | null = null) => ({
	id, name: id, sourceResumeId, updatedAt: date, data: structuredClone(defaultResumeData),
});
const resultRows = (rows: unknown[]) => ({ from: () => ({ where: async () => rows }) });

beforeEach(() => { dbMock.select.mockReset(); });

describe("owned saved-source comparisons", () => {
	it("stops before reading a source when the target is unavailable", async () => {
		dbMock.select.mockReturnValueOnce(resultRows([]));
		await expect(compareResumes({ userId: "owner", resumeId: "foreign" })).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(dbMock.select).toHaveBeenCalledTimes(1);
	});

	it("requires a live owned source before looking up any historical version", async () => {
		dbMock.select.mockReturnValueOnce(resultRows([row("draft", "source")])).mockReturnValueOnce(resultRows([]));
		await expect(compareResumes({ userId: "owner", resumeId: "draft", sourceVersionId: "foreign-version" })).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(dbMock.select).toHaveBeenCalledTimes(2);
	});

	it("reports identical current content and includes the comparison timestamps", async () => {
		dbMock.select.mockReturnValueOnce(resultRows([row("draft", "source")])).mockReturnValueOnce(resultRows([row("source")]));
		const result = await compareResumes({ userId: "owner", resumeId: "draft" });
		expect(result).toMatchObject({ identical: true, files: [], source: { id: "source", updatedAt: date, versionId: null }, target: { id: "draft", updatedAt: date } });
		expect(result).not.toHaveProperty("profile");
	});

	it("uses the selected historical snapshot rather than substituting the current source", async () => {
		const historical = structuredClone(defaultResumeData);
		historical.basics.headline = "Original heading";
		const versionDate = new Date("2026-10-18T00:00:00Z");
		dbMock.select.mockReturnValueOnce(resultRows([row("draft", "source")]))
			.mockReturnValueOnce(resultRows([row("source")]))
			.mockReturnValueOnce(resultRows([{ data: historical, createdAt: versionDate }]));
		const result = await compareResumes({ userId: "owner", resumeId: "draft", sourceVersionId: "version" });
		expect(result.source).toMatchObject({ versionId: "version", updatedAt: versionDate });
		expect(result.identical).toBe(false);
		expect(result.files.flatMap((file) => file.lines).some((line) => line.kind === "removed" && line.text.includes("Original heading"))).toBe(true);
	});
});
