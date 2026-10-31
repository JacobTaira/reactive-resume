import type { ReviewResumeSnapshot } from "./queue-review-pdf";
import { describe, expect, it, vi } from "vitest";
import { createReviewPdf } from "./queue-review-pdf";

const at = new Date("2026-10-29T12:00:00Z");

function fixture(latex = true) {
	const resume = {
		id: "draft", name: "Example — Engineer", slug: "example", updatedAt: at, applicationId: "job",
		data: { ...(latex ? { latex: { engine: "pdflatex", entrypoint: "main.tex", files: [] } } : {}) },
	} as unknown as ReviewResumeSnapshot;
	const services = {
		compile: vi.fn(async () => ({ success: true as const, pdf: btoa("%PDF-1.7\nfixture"), resumeUpdatedAt: at })),
		read: vi.fn(async () => ({ updatedAt: at, applicationId: "job" })),
		render: vi.fn(async () => new Blob(["%PDF-1.7\nstructured"], { type: "application/pdf" })),
	};
	return { resume, services };
}

describe("prepared-resume PDF snapshots", () => {
	it("compiles the owned saved version and returns those exact PDF bytes", async () => {
		const { resume, services } = fixture();
		const result = await createReviewPdf(resume, "job", services);
		expect(services.compile).toHaveBeenCalledWith({ id: "draft", expectedUpdatedAt: at, expectedPageCount: 1 });
		expect(await result.blob.text()).toBe("%PDF-1.7\nfixture");
		expect(services.render).not.toHaveBeenCalled();
	});

	it("refuses another job's draft before compilation", async () => {
		const { resume, services } = fixture();
		await expect(createReviewPdf(resume, "another-job", services)).rejects.toMatchObject({ reason: "link" });
		expect(services.compile).not.toHaveBeenCalled();
	});

	it("does not return a stale PDF when source changes during compilation", async () => {
		const { resume, services } = fixture();
		services.read.mockResolvedValue({ updatedAt: new Date(at.getTime() + 1), applicationId: "job" });
		await expect(createReviewPdf(resume, "job", services)).rejects.toMatchObject({ reason: "changed" });
	});

	it("rejects a PDF if the job linkage changes during generation", async () => {
		const { resume, services } = fixture();
		services.read.mockResolvedValue({ updatedAt: at, applicationId: "different-job" });
		await expect(createReviewPdf(resume, "job", services)).rejects.toMatchObject({ reason: "link" });
	});

	it("rejects a compile receipt that does not attest to the saved source", async () => {
		const { resume, services } = fixture();
		services.compile.mockResolvedValue({ success: true, pdf: btoa("%PDF-1.7\nfixture"), resumeUpdatedAt: new Date(at.getTime() + 1) });
		await expect(createReviewPdf(resume, "job", services)).rejects.toMatchObject({ reason: "changed" });
	});

	it("rejects invalid PDF bytes", async () => {
		const { resume, services } = fixture();
		services.compile.mockResolvedValue({ success: true, pdf: btoa("<html>error</html>"), resumeUpdatedAt: at });
		await expect(createReviewPdf(resume, "job", services)).rejects.toMatchObject({ reason: "invalid-pdf" });
	});

	it("uses the existing renderer for structured resumes and still checks freshness", async () => {
		const { resume, services } = fixture(false);
		const result = await createReviewPdf(resume, "job", services);
		expect(await result.blob.text()).toBe("%PDF-1.7\nstructured");
		expect(services.compile).not.toHaveBeenCalled();
		expect(services.read).toHaveBeenCalledWith({ id: "draft" });
	});
});
