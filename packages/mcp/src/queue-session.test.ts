import { describe, expect, it, vi } from "vitest";
import { ORPCError } from "@orpc/server";
import { prepareQueuedResume } from "./queue-session";

const beforeLink = new Date("2026-10-19T07:35:26.440Z");
const afterLink = new Date("2026-10-19T07:35:50.957Z");
const leaseToken = "a".repeat(64);

function document(id: string, name: string, extra: Record<string, unknown> = {}) {
	return {
		id, name, type: "resume", tags: [], updatedAt: beforeLink, trashedAt: null,
		isLocked: false, sourceResumeId: null, application: null, profile: null,
		...extra,
	};
}

function fixture() {
	const events: string[] = [];
	const documents = [document("base", "Base Resume")];
	const initialItem = {
		id: "job", company: "Example Robotics", role: "Robotics Engineer", description: "Build truthful robotics systems.",
		preparation: { state: "pending", revision: 3, draftResumeId: null as string | null },
	};
	const base = { id: "base", name: "Base Resume", updatedAt: beforeLink, applicationId: null, data: { latex: {} } };
	const draft = { id: "draft", name: "Example Robotics — Robotics Engineer", updatedAt: afterLink, applicationId: "job", data: { latex: {} } };
	const client = {
		documents: {
			list: vi.fn(async () => { events.push("list"); return documents; }),
			copyForJob: vi.fn(async () => { events.push("copy"); return "draft"; }),
			linkApplication: vi.fn(),
		},
		resume: {
			duplicate: vi.fn(),
			getById: vi.fn(async ({ id }: { id: string }) => {
				events.push(`read:${id}`);
				if (id === "base") return base;
				if (id === "draft") return draft;
				throw new ORPCError("NOT_FOUND");
			}),
		},
		applications: {
			queue: {
				read: vi.fn(async () => { events.push("queue.read"); return initialItem; }),
				claim: vi.fn(async () => {
					events.push("claim");
					return { item: { ...initialItem, preparation: { ...initialItem.preparation, state: "processing", revision: 4 } }, leaseToken };
				}),
				update: vi.fn(async ({ draftResumeId }: { draftResumeId: string }) => {
					events.push("update");
					return { ...initialItem, preparation: { ...initialItem.preparation, state: "processing", revision: 5, draftResumeId } };
				}),
			},
		},
		library: {
			companies: { list: vi.fn(async () => [] as { id: string; company: string }[]), getById: vi.fn() },
			resumes: { index: vi.fn() },
		},
	};
	return { client, events, documents, initialItem, base, draft };
}

describe("queued-resume preparation", () => {
	it("resolves Master_Resume and Master Resume without requiring a rename", async () => {
		for (const name of ["Master_Resume", "  MASTER   RESUME  "]) {
			const { client, documents } = fixture();
			const master = documents[0];
			if (!master) throw new Error("Missing fixture master");
			master.name = name;
			const result = await prepareQueuedResume(client as never, { applicationId: "job" });
			expect(result.base.id).toBe("base");
		}
	});

	it("requires an explicit base ID when old and new master names both exist", async () => {
		const { client, documents } = fixture();
		documents.push(document("other", "Master_Resume"));
		await expect(prepareQueuedResume(client as never, { applicationId: "job" }))
			.rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(client.applications.queue.claim).not.toHaveBeenCalled();
		const result = await prepareQueuedResume(client as never, { applicationId: "job", baseResumeId: "base" });
		expect(result.base.id).toBe("base");
	});

	it("claims, copies for the job, records progress, then reads the final linked draft once", async () => {
		const { client, events } = fixture();
		const result = await prepareQueuedResume(client as never, { applicationId: "job" });

		expect(events).toEqual(["queue.read", "list", "read:base", "claim", "copy", "update", "read:draft"]);
		expect(client.documents.list).toHaveBeenCalledWith({ trashed: false, includeProfile: false });
		expect(client.documents.copyForJob).toHaveBeenCalledWith({
			resumeId: "base", applicationId: "job", name: "Example Robotics — Robotics Engineer", reuseExisting: true,
		});
		expect(client.applications.queue.update).toHaveBeenCalledWith({
			id: "job", expectedRevision: 4, leaseToken, draftResumeId: "draft",
		});
		expect(result.draft.updatedAt).toEqual(afterLink);
		expect(result.item.preparation.revision).toBe(5);
		expect(result.base).toEqual({ id: "base", updatedAt: beforeLink });
		expect(result.leaseToken).toBe(leaseToken);
		expect(client.resume.duplicate).not.toHaveBeenCalled();
		expect(client.documents.linkApplication).not.toHaveBeenCalled();
		expect(client.library.resumes.index).not.toHaveBeenCalled();
	});

	it("reuses an owned live draft from the selected base without creating another copy", async () => {
		const { client, documents, initialItem } = fixture();
		initialItem.preparation.draftResumeId = "draft";
		documents.push(document("draft", "Existing work", {
			sourceResumeId: "base", application: { id: "job", company: "Example Robotics", role: "Robotics Engineer" },
		}));
		const result = await prepareQueuedResume(client as never, { applicationId: "job", leaseToken });

		expect(result.draft.id).toBe("draft");
		expect(client.documents.copyForJob).not.toHaveBeenCalled();
		expect(client.applications.queue.claim).toHaveBeenCalledWith({ id: "job", expectedRevision: 3, leaseToken });
		expect(client.resume.getById.mock.calls).toEqual([[{ id: "base" }], [{ id: "draft" }]]);
	});

	it("does not copy or write progress after a queue revision or competing-lease conflict", async () => {
		const { client } = fixture();
		client.applications.queue.claim.mockRejectedValue(new ORPCError("CONFLICT"));

		await expect(prepareQueuedResume(client as never, { applicationId: "job" })).rejects.toMatchObject({ code: "CONFLICT" });
		expect(client.applications.queue.claim).toHaveBeenCalledWith({ id: "job", expectedRevision: 3 });
		expect(client.documents.copyForJob).not.toHaveBeenCalled();
		expect(client.applications.queue.update).not.toHaveBeenCalled();
		expect(client.resume.getById.mock.calls).toEqual([[{ id: "base" }]]);
	});

	it("keeps a saved-company lookup failure visible without blocking the prepared draft", async () => {
		const { client } = fixture();
		client.library.companies.list.mockRejectedValue(new Error("Database lookup failed"));

		const result = await prepareQueuedResume(client as never, { applicationId: "job" });

		expect(result.draft.id).toBe("draft");
		expect(result.context.companies).toEqual([]);
		expect(result.warnings).toEqual(["Saved company research could not be loaded; no new company research was fetched."]);
	});

	it("returns bounded related and matching-company context without profiles or heavy ranking queries", async () => {
		const { client, documents } = fixture();
		documents.push(
			document("related", "Other Robotics Resume", { profile: null, tags: ["ROS 2"] }),
			document("same-company", "Earlier related work", { application: { id: "older-job", company: "Example Robotics", role: "Research" } }),
			document("unrelated", "Marketing Resume", { profile: null }),
		);
		client.library.companies.list.mockResolvedValue([{ id: "company", company: "Example Robotics" }]);
		client.library.companies.getById.mockResolvedValue({
			id: "company", company: "Example Robotics", revision: 2, updatedAt: beforeLink,
			summary: "Build safe robotics", coreValues: ["Safety"], hiringPriorities: ["Practical experiments"],
			culture: "Collaborative", notes: "Use verified evidence", sources: [],
		});

		const result = await prepareQueuedResume(client as never, { applicationId: "job" });

		expect(result.context.related.map((entry) => entry.id)).toEqual(["same-company", "related"]);
		expect(result.context.related[0]).not.toHaveProperty("profile");
		expect(result.context.companies[0]).toMatchObject({ id: "company", notes: "Use verified evidence", truncated: false });
		expect(client.library.companies.getById).toHaveBeenCalledWith({ id: "company" });
		expect(client.library.resumes.index).not.toHaveBeenCalled();
	});

	it("requires an explicit choice when Base Resume is missing or ambiguous", async () => {
		for (const ambiguous of [false, true]) {
			const { client, documents } = fixture();
			if (ambiguous) documents.push(document("second-base", "  BASE  RESUME  "));
			else documents.splice(0);

			await expect(prepareQueuedResume(client as never, { applicationId: "job" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(client.applications.queue.claim).not.toHaveBeenCalled();
			expect(client.documents.copyForJob).not.toHaveBeenCalled();
		}
	});

	it("verifies ownership of an explicitly selected base before claiming or copying", async () => {
		const { client } = fixture();

		await expect(prepareQueuedResume(client as never, { applicationId: "job", baseResumeId: "unowned" }))
			.rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(client.applications.queue.claim).not.toHaveBeenCalled();
		expect(client.documents.copyForJob).not.toHaveBeenCalled();
	});

	it("preserves existing work from a different base instead of replacing it silently", async () => {
		const { client, documents, initialItem } = fixture();
		initialItem.preparation.draftResumeId = "draft";
		documents.push(document("draft", "Existing work", {
			sourceResumeId: "another-base", application: { id: "job", company: "Example Robotics", role: "Robotics Engineer" },
		}));

		await expect(prepareQueuedResume(client as never, { applicationId: "job" })).rejects.toMatchObject({ code: "CONFLICT" });
		expect(client.applications.queue.claim).not.toHaveBeenCalled();
		expect(client.documents.copyForJob).not.toHaveBeenCalled();
	});

	it("does not reuse a draft ID linked to another job", async () => {
		const { client, documents, initialItem } = fixture();
		initialItem.preparation.draftResumeId = "unrelated-draft";
		documents.push(document("unrelated-draft", "Other work", {
			sourceResumeId: "base", application: { id: "another-job", company: "Other", role: "Robotics" },
		}));

		const result = await prepareQueuedResume(client as never, { applicationId: "job" });

		expect(result.draft.id).toBe("draft");
		expect(client.documents.copyForJob).toHaveBeenCalledOnce();
	});

	it("releases its own lease after a copy failure without replacing the original error or saved progress", async () => {
		const { client } = fixture();
		const original = new Error("Copy failed");
		client.documents.copyForJob.mockRejectedValue(original);

		await expect(prepareQueuedResume(client as never, { applicationId: "job" })).rejects.toBe(original);

		expect(client.applications.queue.update).toHaveBeenCalledWith({
			id: "job", expectedRevision: 4, leaseToken, state: "failed",
		});
		expect(client.applications.queue.update.mock.calls[0]?.[0]).not.toHaveProperty("draftResumeId");
		expect(client.applications.queue.update.mock.calls[0]?.[0]).not.toHaveProperty("notes");
	});

	it("uses the last acknowledged revision when recording a failed draft-link update", async () => {
		const { client } = fixture();
		const original = new Error("Progress update failed");
		client.applications.queue.update.mockRejectedValueOnce(original);

		await expect(prepareQueuedResume(client as never, { applicationId: "job" })).rejects.toBe(original);

		expect(client.applications.queue.update.mock.calls).toEqual([
			[{ id: "job", expectedRevision: 4, leaseToken, draftResumeId: "draft" }],
			[{ id: "job", expectedRevision: 4, leaseToken, state: "failed" }],
		]);
	});

	it("releases the latest acknowledged revision after the final draft read fails", async () => {
		const { client, base } = fixture();
		const original = new Error("Final draft read failed");
		client.resume.getById.mockImplementation(async ({ id }: { id: string }) => {
			if (id === "base") return base;
			throw original;
		});

		await expect(prepareQueuedResume(client as never, { applicationId: "job" })).rejects.toBe(original);

		expect(client.applications.queue.update).toHaveBeenCalledWith({
			id: "job", expectedRevision: 5, leaseToken, state: "failed",
		});
	});

	it("never overrides a conflicting cleanup or masks the original preparation failure", async () => {
		const { client } = fixture();
		const original = new Error("Copy response was lost");
		client.documents.copyForJob.mockRejectedValue(original);
		client.applications.queue.update.mockRejectedValue(new ORPCError("CONFLICT"));

		await expect(prepareQueuedResume(client as never, { applicationId: "job" })).rejects.toBe(original);

		expect(client.applications.queue.update).toHaveBeenCalledOnce();
		expect(client.applications.queue.claim).toHaveBeenCalledOnce();
	});
});

