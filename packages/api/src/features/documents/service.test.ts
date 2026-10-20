import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({ select: vi.fn(), update: vi.fn(), transaction: vi.fn() }));
const resumeServiceMock = vi.hoisted(() => ({
	getById: vi.fn(),
	create: vi.fn(),
	delete: vi.fn(),
	setLocked: vi.fn(),
}));
const applicationServiceMock = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock("@reactive-resume/db/client", () => ({ db: dbMock }));
vi.mock("../resume/service", () => ({ resumeService: resumeServiceMock }));
vi.mock("../cover-letters/service", () => ({ coverLetterService: { getById: vi.fn(), update: vi.fn() } }));
vi.mock("../applications/service", () => ({ applicationService: applicationServiceMock }));

const { documentsService } = await import("./service");

// `select().from().where()` resolving to `rows`.
const rows = (result: unknown[]) => ({ from: () => ({ where: () => Promise.resolve(result) }) });
const joinedRows = (result: unknown[]) => ({ from: () => ({ leftJoin: () => ({ where: () => Promise.resolve(result) }) }) });

const updates = () => {
	const set = vi.fn((_changes: Record<string, unknown>) => ({
		where: () => ({ returning: async () => [{ id: "copy" }] }),
	}));
	dbMock.update.mockReturnValue({ set });
	return set;
};

beforeEach(() => {
	for (const mock of [
		...Object.values(dbMock),
		...Object.values(resumeServiceMock),
		...Object.values(applicationServiceMock),
	])
		mock.mockReset();
	dbMock.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
		callback({
			select: () => ({ from: () => ({ where: () => ({ for: async () => [{ id: "u1" }] }) }) }),
			update: dbMock.update,
		}),
	);
});

describe("list profiles", () => {
	const summary = {
		id: "r1", name: "Base Resume", tags: ["robotics"], isLocked: false, isPublic: false,
		slug: "base", trashedAt: null, createdAt: new Date("2026-10-01T00:00:00Z"),
		updatedAt: new Date("2026-10-19T00:00:00Z"), folderId: null, sourceResumeId: null,
		companyId: null, applicationId: "a1", company: "Orbital", role: "Engineer",
	};

	it("omits invalid legacy audit metadata without blocking document discovery", async () => {
		dbMock.select.mockReturnValueOnce(joinedRows([{ ...summary, profile: { score: "invalid legacy value" } }]));
		dbMock.select.mockReturnValueOnce(joinedRows([]));
		const result = await documentsService.list({ userId: "u1", trashed: false, includeProfile: false });

		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			id: "r1", name: "Base Resume", tags: ["robotics"], profile: null,
			application: { id: "a1", company: "Orbital", role: "Engineer" },
		});
		// A SQL null projection keeps even oversized/unparseable profiles out of the database result.
		expect(dbMock.select.mock.calls[0]?.[0].profile).toHaveProperty("queryChunks");
	});

	it.each([undefined, true])("keeps normal profile behavior when includeProfile is %s", async includeProfile => {
		dbMock.select.mockReturnValueOnce(joinedRows([{ ...summary, profile: { purpose: "master", score: 85 } }]));
		dbMock.select.mockReturnValueOnce(joinedRows([]));
		const result = await documentsService.list({
			userId: "u1", trashed: false, ...(includeProfile !== undefined ? { includeProfile } : {}),
		});
		expect(result[0]?.profile).toMatchObject({ purpose: "master", score: 85, requirementEvidence: [] });
		expect(dbMock.select.mock.calls[0]?.[0].profile).not.toHaveProperty("queryChunks");
	});

	it("retains legacy validation failures when profile inclusion is requested", async () => {
		dbMock.select.mockReturnValueOnce(joinedRows([{ ...summary, profile: { score: "invalid legacy value" } }]));
		dbMock.select.mockReturnValueOnce(joinedRows([]));
		await expect(documentsService.list({ userId: "u1", trashed: false })).rejects.toBeDefined();
	});
});

describe("Trash", () => {
	it("won't move a locked document, and keeps the resume's error code", async () => {
		dbMock.select.mockReturnValueOnce(rows([{ isLocked: true, trashedAt: null }]));

		await expect(documentsService.trash({ userId: "u1", type: "resume", id: "r1" })).rejects.toMatchObject({
			code: "RESUME_LOCKED",
			status: 403,
		});
		expect(dbMock.update).not.toHaveBeenCalled();
	});

	it("deletes for good only what is already in Trash", async () => {
		dbMock.select.mockReturnValueOnce(rows([{ isLocked: false, trashedAt: null }]));
		await expect(documentsService.purge({ userId: "u1", type: "resume", id: "r1" })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});

		dbMock.select.mockReturnValueOnce(rows([{ isLocked: false, trashedAt: new Date() }]));
		await documentsService.purge({ userId: "u1", type: "resume", id: "r1" });
		expect(resumeServiceMock.delete).toHaveBeenCalledWith({ id: "r1", userId: "u1" });
	});
});

describe("copyForJob", () => {
	const source = {
		name: "Product Designer — Lumen",
		tags: ["design"],
		data: { metadata: { page: { locale: "en-US" } } },
	};

	it("delegates a Saved job's copy and selected-resume link to one atomic create", async () => {
		resumeServiceMock.getById.mockResolvedValueOnce(source);
		dbMock.select.mockReturnValueOnce(rows([{
			id: "a1", company: "Orbital", role: "Designer", status: "saved", resumeId: null, sentResumeVersionId: null,
		}]));
		resumeServiceMock.create.mockResolvedValueOnce("copy");

		const id = await documentsService.copyForJob({ userId: "u1", resumeId: "r1", applicationId: "a1" });

		expect(id).toBe("copy");
		expect(resumeServiceMock.create).toHaveBeenCalledWith({
			userId: "u1",
			name: "Product Designer — Orbital",
			tags: ["design"],
			copyFromResumeId: "r1",
			jobApplicationId: "a1",
			reuseApplicationDraft: false,
			locale: "en-US",
			data: source.data,
		});
		expect(dbMock.update).not.toHaveBeenCalled();
		expect(applicationServiceMock.update).not.toHaveBeenCalled();
	});

	it("reuses the atomic Saved-job draft when a queue run retries after losing the response", async () => {
		resumeServiceMock.getById.mockResolvedValueOnce(source);
		dbMock.select.mockReturnValueOnce(rows([{
			id: "a1", company: "Orbital", role: "Designer", status: "saved", resumeId: "existing", sentResumeVersionId: null,
		}]));
		resumeServiceMock.create.mockResolvedValueOnce("existing");
		await expect(documentsService.copyForJob({
			userId: "u1", resumeId: "r1", applicationId: "a1", name: "Mine", reuseExisting: true,
		})).resolves.toBe("existing");
		expect(resumeServiceMock.create).toHaveBeenCalledWith(expect.objectContaining({
			copyFromResumeId: "r1", jobApplicationId: "a1", reuseApplicationDraft: true, name: "Mine",
		}));
		expect(dbMock.update).not.toHaveBeenCalled();
		expect(applicationServiceMock.update).not.toHaveBeenCalled();
	});

	it.each([
		{ applicationId: undefined, application: null },
		{ applicationId: "a1", application: { id: "a1", status: "applied", sentResumeVersionId: null } },
		{ applicationId: "a1", application: { id: "a1", status: "saved", sentResumeVersionId: "submitted-version" } },
	])("rejects draft reuse outside an unsubmitted Saved job: %j", async ({ applicationId, application }) => {
		resumeServiceMock.getById.mockResolvedValueOnce(source);
		if (application) dbMock.select.mockReturnValueOnce(rows([application]));
		await expect(documentsService.copyForJob({
			userId: "u1", resumeId: "r1", applicationId, reuseExisting: true,
		})).rejects.toMatchObject({ code: "CONFLICT" });
		expect(resumeServiceMock.create).not.toHaveBeenCalled();
		expect(dbMock.update).not.toHaveBeenCalled();
		expect(applicationServiceMock.update).not.toHaveBeenCalled();
	});

	it("can prepare a fresh copy for an Applied job without replacing its submitted resume", async () => {
		resumeServiceMock.getById.mockResolvedValueOnce(source);
		dbMock.select.mockReturnValueOnce(rows([{
			id: "a1", company: "Orbital", role: "Designer", status: "applied",
			resumeId: "submitted", sentResumeVersionId: "version",
		}]));
		resumeServiceMock.create.mockResolvedValueOnce("copy");
		const set = updates();

		await documentsService.copyForJob({ userId: "u1", resumeId: "r1", applicationId: "a1", name: "Mine" });

		expect(resumeServiceMock.create).toHaveBeenCalledWith(expect.objectContaining({ name: "Mine", data: source.data }));
		expect(resumeServiceMock.create.mock.calls[0]?.[0]).not.toHaveProperty("jobApplicationId");
		expect(set).toHaveBeenCalledTimes(2);
		expect(set).toHaveBeenCalledWith({ applicationId: "a1" });
		expect(set).toHaveBeenCalledWith(expect.objectContaining({
			sourceResumeId: "r1",
			profile: expect.objectContaining({ purpose: "tailored", company: "Orbital", targetRole: "Designer", score: null }),
		}));
		expect(applicationServiceMock.update).not.toHaveBeenCalled();
	});
});

describe("linkApplication", () => {
	it.each([
		{ status: "saved", resumeId: null, sentResumeVersionId: null, selected: true },
		{ status: "saved", resumeId: "base", sentResumeVersionId: null, selected: true },
		{ status: "applied", resumeId: "submitted", sentResumeVersionId: "version", selected: false },
		{ status: "saved", resumeId: "submitted", sentResumeVersionId: "version", selected: false },
	])("links manual preparation while preserving submission history: %j", async ({ selected, ...application }) => {
		dbMock.select.mockReturnValueOnce(rows([{ isLocked: false, trashedAt: null }]));
		dbMock.select.mockReturnValueOnce(rows([{ id: "a1", company: "Orbital", ...application }]));
		const set = vi.fn(() => ({ where: () => ({ returning: async () => [{ id: "new" }] }) }));
		dbMock.update.mockReturnValue({ set });
		await documentsService.linkApplication({ userId: "u1", type: "resume", id: "new", applicationId: "a1" });
		expect(set).toHaveBeenCalledWith({ applicationId: "a1" });
		if (selected)
			expect(applicationServiceMock.update).toHaveBeenCalledWith({ userId: "u1", id: "a1", resumeId: "new" });
		else expect(applicationServiceMock.update).not.toHaveBeenCalled();
	});
});

