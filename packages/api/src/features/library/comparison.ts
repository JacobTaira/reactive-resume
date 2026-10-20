import type z from "zod";
import type { resumeComparisonDto } from "../../dto/resume-comparison";
import { ORPCError } from "@orpc/client";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";
import { compareResumeData } from "@reactive-resume/resume/compare";
import { parseStoredResumeData } from "../resume/resume-data-validation";

export async function compareResumes(input: z.infer<typeof resumeComparisonDto.input> & { userId: string }) {
	const getOwned = async (id: string) => {
		const [row] = await db.select({
			id: schema.resume.id, name: schema.resume.name, updatedAt: schema.resume.updatedAt,
			data: schema.resume.data, sourceResumeId: schema.resume.sourceResumeId,
		}).from(schema.resume).where(and(eq(schema.resume.id, id), eq(schema.resume.userId, input.userId), isNull(schema.resume.trashedAt)));
		if (!row) throw new ORPCError("NOT_FOUND", { message: "Resume not found." });
		return row;
	};
	const target = await getOwned(input.resumeId);
	const sourceId = input.sourceResumeId ?? target.sourceResumeId;
	if (!sourceId) throw new ORPCError("BAD_REQUEST", { message: "Choose a source resume to compare." });
	const source = await getOwned(sourceId);
	let sourceData = source.data;
	let sourceDate = source.updatedAt;
	if (input.sourceVersionId) {
		const [version] = await db.select({ data: schema.resumeVersion.data, createdAt: schema.resumeVersion.createdAt })
			.from(schema.resumeVersion).where(and(
				eq(schema.resumeVersion.id, input.sourceVersionId), eq(schema.resumeVersion.resumeId, source.id), eq(schema.resumeVersion.userId, input.userId),
			));
		if (!version) throw new ORPCError("NOT_FOUND", { message: "Source resume version not found." });
		sourceData = version.data;
		sourceDate = version.createdAt;
	}
	return {
		source: { id: source.id, name: source.name, updatedAt: sourceDate, versionId: input.sourceVersionId ?? null },
		target: { id: target.id, name: target.name, updatedAt: target.updatedAt, versionId: null },
		...compareResumeData(parseStoredResumeData(sourceData), parseStoredResumeData(target.data)),
	};
}
