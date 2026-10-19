import { beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@reactive-resume/db/schema";

const dbMock = vi.hoisted(() => ({ select: vi.fn(), update: vi.fn(), insert: vi.fn(), delete: vi.fn(), transaction: vi.fn() }));
const lockOwner = vi.hoisted(() => vi.fn());
vi.mock("@reactive-resume/db/client", () => ({ db: dbMock }));
vi.mock("../documents/ownership", () => ({ lockDocumentOwner: lockOwner }));

const { libraryService } = await import("./service");
const { resumeProfileSchema } = await import("../../dto/library");

const forUpdate = vi.fn();
function resultRows(result: unknown[]) {
	const promise = Promise.resolve(result);
	return { from: () => ({ where: () => ({ then: promise.then.bind(promise), for: forUpdate.mockImplementation(() => promise) }) }) };
}

const current = {
	resumeId: "resume", folderId: null, sourceResumeId: null, companyId: null,
	profile: resumeProfileSchema.parse({ purpose: "master", company: "Orbital", keywords: ["ROS"] }),
	updatedAt: new Date("2026-10-18T10:00:00Z"),
};

beforeEach(() => {
	for (const mock of Object.values(dbMock)) mock.mockReset();
	lockOwner.mockReset().mockResolvedValue(undefined);
	forUpdate.mockReset();
	dbMock.transaction.mockImplementation((callback: (tx: typeof dbMock) => unknown) => callback(dbMock));
	dbMock.update.mockReturnValue({ set: () => ({ where: async () => [] }) });
	dbMock.delete.mockReturnValue({ where: async () => [] });
});

describe("owned library mutations", () => {
	it("does not write when the resume or destination folder is not owned", async () => {
		dbMock.select.mockReturnValueOnce(resultRows([]));
		await expect(libraryService.resumes.setMetadata({ userId: "owner", resumeId: "foreign" })).rejects.toMatchObject({ code: "NOT_FOUND" });
		dbMock.select.mockReturnValueOnce(resultRows([current])).mockReturnValueOnce(resultRows([]));
		await expect(libraryService.resumes.setMetadata({ userId: "owner", resumeId: "resume", folderId: "foreign-folder" })).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(dbMock.update).not.toHaveBeenCalled();
	});
	it("locks the resume before merging metadata and never writes printable or LaTeX content", async () => {
		dbMock.select.mockReturnValueOnce(resultRows([current])).mockReturnValueOnce(resultRows([current]));
		const set = vi.fn((_changes: Record<string, unknown>) => ({ where: async () => [] }));
		dbMock.update.mockReturnValue({ set });
		await libraryService.resumes.setMetadata({ userId: "owner", resumeId: "resume", profile: { score: 92 } });
		expect(forUpdate).toHaveBeenCalledWith("update");
		const changes = set.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
		expect(changes).not.toHaveProperty("data");
		expect(changes).toMatchObject({ updatedAt: current.updatedAt, profile: { purpose: "master", company: "Orbital", keywords: ["ROS"], score: 92, evaluatedResumeUpdatedAt: current.updatedAt.toISOString() } });
	});
	it("invalidates an existing evaluation when its target changes without a new score", async () => {
		const evaluated = { ...current, profile: { ...current.profile, score: 90, evaluatedAt: current.updatedAt.toISOString(), evaluatedResumeUpdatedAt: current.updatedAt.toISOString() } };
		dbMock.select.mockReturnValueOnce(resultRows([evaluated])).mockReturnValueOnce(resultRows([evaluated]));
		const set = vi.fn(() => ({ where: async () => [] }));
		dbMock.update.mockReturnValue({ set });
		await libraryService.resumes.setMetadata({ userId: "owner", resumeId: "resume", profile: { targetRole: "Controls Engineer" } });
		expect(set).toHaveBeenCalledWith(expect.objectContaining({ profile: expect.objectContaining({ score: 90, evaluatedAt: null, evaluatedResumeUpdatedAt: null }) }));
	});
	it("rejects a stale company revision before replacing research", async () => {
		dbMock.select.mockReturnValueOnce(resultRows([{ id: "company" }])).mockReturnValueOnce(resultRows([{ id: "company", revision: 4 }]));
		await expect(libraryService.companies.save({ userId: "owner", id: "company", company: "Orbital", expectedRevision: 3, notes: "Stale notes" })).rejects.toMatchObject({ code: "CONFLICT" });
		expect(dbMock.update).not.toHaveBeenCalled();
	});
	it("rejects unavailable evidence sources before saving a support claim", async () => {
		dbMock.select.mockReturnValueOnce(resultRows([current])).mockReturnValueOnce(resultRows([]));
		await expect(libraryService.resumes.setMetadata({ userId: "owner", resumeId: "resume", profile: {
			requirementEvidence: [{ requirement: "ROS", importance: "required", status: "supported", notes: "", evidence: [{ resumeId: "another-owner", locator: "Experience", quote: "Built ROS systems" }] }],
		} })).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(dbMock.update).not.toHaveBeenCalled();
	});
	it("locks the current source before accepting its review timestamp", async () => {
		const source = { ...current, resumeId: "source", updatedAt: new Date("2026-10-18T09:00:00Z") };
		const derived = { ...current, sourceResumeId: "source" };
		dbMock.select.mockReturnValueOnce(resultRows([derived])).mockReturnValueOnce(resultRows([source])).mockReturnValueOnce(resultRows([derived]));
		await libraryService.resumes.setMetadata({ userId: "owner", resumeId: "resume", profile: {
			reviewedResumeUpdatedAt: current.updatedAt.toISOString(), reviewedSourceUpdatedAt: source.updatedAt.toISOString(),
		} });
		expect(forUpdate).toHaveBeenCalledWith("share");
		expect(dbMock.update).toHaveBeenCalledWith(schema.resume);
	});
	it("deletes only the folder after moving its contents up, never the resumes", async () => {
		dbMock.select.mockReturnValueOnce(resultRows([{ id: "child", parentId: "parent" }]));
		const set = vi.fn(() => ({ where: async () => [] }));
		dbMock.update.mockReturnValue({ set });
		await libraryService.folders.delete({ userId: "owner", id: "child" });
		expect(set).toHaveBeenCalledWith({ parentId: "parent" });
		expect(set).toHaveBeenCalledWith(expect.objectContaining({ folderId: "parent" }));
		expect(dbMock.delete).toHaveBeenCalledTimes(1);
		expect(dbMock.delete).toHaveBeenCalledWith(schema.resumeFolder);
	});
});
