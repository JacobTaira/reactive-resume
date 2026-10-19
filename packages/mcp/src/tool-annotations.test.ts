import { describe, expect, it } from "vitest";
import { MCP_TOOL_NAME } from "./mcp-tool-names";
import { TOOL_META } from "./tool-meta";

describe("tool annotations", () => {
	it("marks tools that replace or remove existing data as destructive", () => {
		for (const name of [
			MCP_TOOL_NAME.patchResume,
			MCP_TOOL_NAME.editResumeLatex,
			MCP_TOOL_NAME.updateResume,
			MCP_TOOL_NAME.deleteResume,
			MCP_TOOL_NAME.updateApplication,
			MCP_TOOL_NAME.deleteApplication,
			MCP_TOOL_NAME.updateApplicationTimelineEntry,
			MCP_TOOL_NAME.updateApplicationInterview,
			MCP_TOOL_NAME.bulkUpdateApplications,
			MCP_TOOL_NAME.bulkDeleteApplications,
			MCP_TOOL_NAME.attachApplicationDocument,
			MCP_TOOL_NAME.removeApplicationDocument,
			MCP_TOOL_NAME.scoreApplicationMatch,
			MCP_TOOL_NAME.tailorResumeForApplication,
			MCP_TOOL_NAME.updateCoverLetter,
			MCP_TOOL_NAME.refreshCoverLetterStyle,
			MCP_TOOL_NAME.deleteCoverLetter,
			MCP_TOOL_NAME.updateResumeFolder,
			MCP_TOOL_NAME.deleteResumeFolder,
			MCP_TOOL_NAME.moveResume,
			MCP_TOOL_NAME.saveCompanyNote,
			MCP_TOOL_NAME.deleteCompanyNote,
			MCP_TOOL_NAME.updateResumeMetadata,
		]) {
			expect(TOOL_META[name].annotations.readOnlyHint, name).toBe(false);
			expect(TOOL_META[name].annotations.destructiveHint, name).toBe(true);
		}
	});

	it("keeps library discovery and evidence reads local and read-only", () => {
		for (const name of [
			MCP_TOOL_NAME.listResumeFolders,
			MCP_TOOL_NAME.listCompanyNotes,
			MCP_TOOL_NAME.readCompanyNote,
			MCP_TOOL_NAME.readResumeMetadata,
			MCP_TOOL_NAME.readResumeLatex,
			MCP_TOOL_NAME.findRelatedResumes,
			MCP_TOOL_NAME.findRelatedJobs,
			MCP_TOOL_NAME.compareResumes,
		]) {
			expect(TOOL_META[name].annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
		}
	});
});

