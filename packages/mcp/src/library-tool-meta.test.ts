import { describe, expect, it } from "vitest";
import { MCP_TOOL_NAME as T } from "./mcp-tool-names";
import { TOOL_META } from "./tool-meta";

describe("library MCP contracts", () => {
	it("exposes evidence status and bounded citations through the metadata contract", () => {
		const schema = TOOL_META[T.updateResumeMetadata].inputSchema;
		const base = {
			resumeId: "draft",
			profile: {
				requirementEvidence: [{
					requirement: "Robotics",
					importance: "required",
					status: "supported",
					evidence: [{ resumeId: "master", locator: "main.tex:42", quote: "Built a robot" }],
					notes: "Verified in source.",
				}],
			},
		};
		expect(schema.safeParse(base).success).toBe(true);
		expect(schema.safeParse({
			resumeId: "draft",
			profile: { requirementEvidence: [{ requirement: "Robotics", status: "invented" }] },
		}).success).toBe(false);
		expect(schema.safeParse({
			resumeId: "draft",
			profile: {
				requirementEvidence: [{
					requirement: "Robotics",
					status: "gap",
					evidence: [{ resumeId: "master", locator: "main.tex", quote: "x".repeat(1_201) }],
				}],
			},
		}).success).toBe(false);
	});

	it("keeps sparse outcome updates sparse instead of clearing evidence and review snapshots", () => {
		const input = { resumeId: "draft", profile: { outcome: { stage: "interview" } } };
		expect(TOOL_META[T.updateResumeMetadata].inputSchema.parse(input)).toEqual(input);
		expect(TOOL_META[T.updateResumeMetadata].inputSchema.safeParse({
			resumeId: "draft", profile: { outcome: { stage: "guaranteed_hire" } },
		}).success).toBe(false);
	});

	it("publishes comparison baseline selection and PDF diagnostic inputs", () => {
		const comparison = { resumeId: "draft", sourceResumeId: "base", sourceVersionId: "snapshot" };
		expect(TOOL_META[T.compareResumes].inputSchema.parse(comparison)).toEqual(comparison);
		expect(TOOL_META[T.compareResumes].annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
		const compile = TOOL_META[T.compileResumeLatex].inputSchema;
		expect(compile.safeParse({ id: "draft", expectedPageCount: 101 }).success).toBe(false);
		expect(compile.parse({ id: "draft", expectedPageCount: 2 })).toEqual({ id: "draft", expectedPageCount: 2 });
	});

	it("describes source comparisons, reported outcomes and automatic company-note creation accurately", () => {
		expect(TOOL_META[T.compareResumes].description).toContain("source's current content");
		expect(TOOL_META[T.compareResumes].description).toContain("coarse/truncated");
		expect(TOOL_META[T.readResumeMetadata].description).toContain("not a computed diff");
		expect(TOOL_META[T.findRelatedResumes].description).toContain("not ATS scoring or causal claims");
		expect(TOOL_META[T.saveCompanyNote].description).toContain("Create or update");
	});
});
