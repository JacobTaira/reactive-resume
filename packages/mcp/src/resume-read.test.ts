import { describe, expect, it } from "vitest";
import { ORPCError } from "@orpc/server";
import { readResumeContext } from "./resume-read";

const updatedAt = new Date("2026-10-19T06:00:00Z");
const resume = { id: "owned-resume", updatedAt, data: { latex: { files: [{ content: "Verified source" }] } } };
const metadata = { resumeId: resume.id, updatedAt, sourceResumeId: "master", profile: { purpose: "tailored" } };

describe("combined resume context", () => {
	it("leaves ordinary reads unchanged and does not request metadata", async () => {
		let metadataReads = 0;
		const client = {
			resume: { getById: async () => resume },
			library: {
				resumes: {
					getMetadata: async () => {
						metadataReads++;
						return metadata;
					},
				},
			},
		};
		for (const input of [{ id: resume.id }, { id: resume.id, includeMetadata: false }]) {
			expect(await readResumeContext(client as never, input)).toEqual(resume);
		}
		expect(metadataReads).toBe(0);
	});

	it("starts both owned reads together and returns their content and timestamps", async () => {
		let resumeStarted = false;
		let metadataStarted = false;
		let release: (value: typeof resume) => void = () => {};
		const client = {
			resume: {
				getById: ({ id }: { id: string }) => {
					expect(id).toBe(resume.id);
					resumeStarted = true;
					return new Promise<typeof resume>((resolve) => {
						release = resolve;
					});
				},
			},
			library: {
				resumes: {
					getMetadata: async ({ resumeId }: { resumeId: string }) => {
						expect(resumeId).toBe(resume.id);
						metadataStarted = true;
						return metadata;
					},
				},
			},
		};
		const pending = readResumeContext(client as never, { id: resume.id, includeMetadata: true });
		expect(resumeStarted).toBe(true);
		expect(metadataStarted).toBe(true);
		release(resume);
		expect(await pending).toEqual({ ...resume, libraryMetadata: metadata });
	});

	it("rejects mismatched content revisions instead of presenting them as one read", async () => {
		const client = {
			resume: { getById: async () => resume },
			library: {
				resumes: {
					getMetadata: async () => ({ ...metadata, updatedAt: new Date(updatedAt.getTime() + 1) }),
				},
			},
		};
		let code;
		try {
			await readResumeContext(client as never, { id: resume.id, includeMetadata: true });
		} catch (error) {
			if (error instanceof ORPCError) code = error.code;
		}
		expect(code).toBe("CONFLICT");
	});

	it("propagates ownership failures without returning partial resume context", async () => {
		const denied = new ORPCError("NOT_FOUND");
		const client = {
			resume: { getById: async () => resume },
			library: {
				resumes: {
					getMetadata: async () => {
						throw denied;
					},
				},
			},
		};
		let failure;
		try {
			await readResumeContext(client as never, { id: resume.id, includeMetadata: true });
		} catch (error) {
			failure = error;
		}
		expect(failure).toBe(denied);
	});
});
