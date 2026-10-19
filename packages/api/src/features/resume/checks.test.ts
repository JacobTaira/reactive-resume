import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRouterClient } from "@orpc/server";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";

const mocks = vi.hoisted(() => ({ getById: vi.fn(), matchJobDescription: vi.fn() }));

vi.mock("../../context", async () => {
	const { os } = await vi.importActual<typeof import("@orpc/server")>("@orpc/server");
	return {
		publicProcedure: os,
		protectedProcedure: os.$context<{ user: { id: string } }>(),
	};
});
vi.mock("./service", () => ({ resumeService: { getById: mocks.getById } }));
vi.mock("./pdf-analysis", () => ({ extractPdf: vi.fn() }));
vi.mock("../../middleware/rate-limit", () => ({
	pdfAnalysisRateLimit: async ({ next }: { next: () => Promise<unknown> }) => next(),
}));
vi.mock("@reactive-resume/resume/ats-pdf", async (importOriginal) => {
	const original = await importOriginal<typeof import("@reactive-resume/resume/ats-pdf")>();
	return { ...original, matchJobDescription: mocks.matchJobDescription };
});

const { matchResume } = await import("./checks");
const client = createRouterClient({ matchResume }, { context: { user: { id: "owner" } } as never });

describe("saved-resume term matching", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getById.mockResolvedValue({ data: structuredClone(defaultResumeData) });
		mocks.matchJobDescription.mockReturnValue({
			terms: [
				{ term: "robotics", jdCount: 1, resumeCount: 1, weight: 1 },
				{ term: "python", jdCount: 1, resumeCount: 0, weight: 1 },
				{ term: "leadership", jdCount: 1, resumeCount: 0, weight: 1 },
			],
		});
	});

	it("rejects LaTeX rather than reporting matches against unrelated structured fields", async () => {
		const data = structuredClone(defaultResumeData);
		data.summary.content = "Structured robotics experience that is absent from the printable source.";
		data.latex = {
			engine: "pdflatex",
			entrypoint: "main.tex",
			files: [{
				path: "main.tex",
				encoding: "utf-8",
				content: "\\documentclass{article}\\begin{document}Python\\end{document}",
			}],
		};
		mocks.getById.mockResolvedValue({ data });

		await expect(client.matchResume({ id: "latex-resume", jobDescription: "Robotics and Python" })).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining("LaTeX PDF"),
		});
		expect(mocks.getById).toHaveBeenCalledWith({ id: "latex-resume", userId: "owner" });
		expect(mocks.matchJobDescription).not.toHaveBeenCalled();
	});

	it("preserves structured matches, hidden terms and posting labels for ordinary resumes", async () => {
		const data = structuredClone(defaultResumeData);
		data.basics.name = "Example Candidate";
		data.metadata.check = { ignored: [], hiddenTerms: ["leadership"] };
		mocks.getById.mockResolvedValue({ data });

		const result = await client.matchResume({
			id: "structured-resume", jobDescription: "Robotics, Python and leadership",
		});

		expect(result).toMatchObject({
			found: [{ term: "robotics", label: "Robotics" }],
			missing: [{ term: "python", label: "Python" }],
			total: 2,
		});
		expect(mocks.matchJobDescription).toHaveBeenCalledWith({
			jobDescription: "Robotics, Python and leadership",
			resumeText: expect.stringContaining("Example Candidate"),
		});
	});
});
