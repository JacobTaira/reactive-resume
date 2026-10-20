import type z from "zod";
import type { DbOrTx } from "@reactive-resume/db/client";
import type { CompanyResearch, ResumeLibraryMetadata } from "../../dto/library";
import { ORPCError } from "@orpc/client";
import { and, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";
import { libraryDto, resumeProfileSchema } from "../../dto/library";
import { lockDocumentOwner } from "../documents/ownership";
import { assertFolderParent, companyKey, evaluationStale, rankResume, resolveResumeOutcome, reviewFreshness } from "./policy";
import { mergeResumeProfile } from "./profile-updates";

type Owned<T> = T & { userId: string };
type FolderCreate = z.infer<typeof libraryDto.folders.create.input>;
type FolderUpdate = z.infer<typeof libraryDto.folders.update.input>;
type CompanySave = z.infer<typeof libraryDto.companies.save.input>;
type MetadataUpdate = z.infer<typeof libraryDto.resumes.setMetadata.input>;
type IndexInput = z.infer<typeof libraryDto.resumes.index.input>;

const folderWhere = (userId: string, id: string) => and(eq(schema.resumeFolder.userId, userId), eq(schema.resumeFolder.id, id));
const companyWhere = (userId: string, id: string) => and(eq(schema.companyResearch.userId, userId), eq(schema.companyResearch.id, id));
const resumeWhere = (userId: string, id: string) => and(eq(schema.resume.userId, userId), eq(schema.resume.id, id), isNull(schema.resume.trashedAt));
const escapeLike = (value: string) => value.replace(/[\\%_]/g, "\\$&");
const searchTerms = (values: (string | undefined)[]) => [...new Set(values.filter((value): value is string => Boolean(value)).flatMap((value) => value.toLowerCase().split(/\s+/).filter(Boolean)))].slice(0, 60);

const folderFields = {
	id: schema.resumeFolder.id, name: schema.resumeFolder.name, parentId: schema.resumeFolder.parentId,
	createdAt: schema.resumeFolder.createdAt, updatedAt: schema.resumeFolder.updatedAt,
};
const metadataFields = {
	resumeId: schema.resume.id, folderId: schema.resume.folderId, sourceResumeId: schema.resume.sourceResumeId,
	companyId: schema.resume.companyId, profile: schema.resume.profile, updatedAt: schema.resume.updatedAt,
};

async function ownedFolder(tx: DbOrTx, userId: string, id: string) {
	const [row] = await tx.select(folderFields).from(schema.resumeFolder).where(folderWhere(userId, id));
	if (!row) throw new ORPCError("NOT_FOUND", { message: "Folder not found." });
	return row;
}

async function ownedCompany(tx: DbOrTx, userId: string, id: string) {
	const [row] = await tx.select().from(schema.companyResearch).where(companyWhere(userId, id));
	if (!row) throw new ORPCError("NOT_FOUND", { message: "Company research not found." });
	return row;
}

async function metadata(tx: DbOrTx, userId: string, resumeId: string, lock: "update" | "share" | false = false): Promise<ResumeLibraryMetadata> {
	const query = tx.select(metadataFields).from(schema.resume).where(resumeWhere(userId, resumeId));
	const [row] = await (lock ? query.for(lock) : query);
	if (!row) throw new ORPCError("NOT_FOUND", { message: "Resume not found." });
	return { ...row, profile: resumeProfileSchema.parse(row.profile) };
}

function publicCompany(row: typeof schema.companyResearch.$inferSelect): CompanyResearch {
	const { userId: _userId, companyKey: _companyKey, ...note } = row;
	return note;
}

export const libraryService = {
	folders: {
		list: (userId: string) => db.select(folderFields).from(schema.resumeFolder).where(eq(schema.resumeFolder.userId, userId)).orderBy(schema.resumeFolder.name, schema.resumeFolder.id),
		create: (input: Owned<FolderCreate>) => db.transaction(async (tx) => {
			await lockDocumentOwner(tx, input.userId);
			const folders = await tx.select(folderFields).from(schema.resumeFolder).where(eq(schema.resumeFolder.userId, input.userId));
			if (folders.length >= 1_000) throw new ORPCError("BAD_REQUEST", { message: "This account has reached the 1,000-folder limit." });
			assertFolderParent(folders, null, input.parentId ?? null);
			const [created] = await tx.insert(schema.resumeFolder).values({ userId: input.userId, name: input.name, parentId: input.parentId ?? null }).returning(folderFields);
			if (!created) throw new ORPCError("INTERNAL_SERVER_ERROR");
			return created;
		}),
		update: (input: Owned<FolderUpdate>) => db.transaction(async (tx) => {
			await lockDocumentOwner(tx, input.userId);
			await ownedFolder(tx, input.userId, input.id);
			if (input.parentId !== undefined) {
				const folders = await tx.select(folderFields).from(schema.resumeFolder).where(eq(schema.resumeFolder.userId, input.userId));
				assertFolderParent(folders, input.id, input.parentId);
			}
			const [updated] = await tx.update(schema.resumeFolder).set({
				...(input.name !== undefined ? { name: input.name } : {}),
				...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
				updatedAt: new Date(),
			}).where(folderWhere(input.userId, input.id)).returning(folderFields);
			if (!updated) throw new ORPCError("NOT_FOUND");
			return updated;
		}),
		delete: (input: Owned<{ id: string }>) => db.transaction(async (tx) => {
			await lockDocumentOwner(tx, input.userId);
			const folder = await ownedFolder(tx, input.userId, input.id);
			// Move children and resumes up one level. Deleting a folder never deletes its contents.
			await tx.update(schema.resumeFolder).set({ parentId: folder.parentId }).where(and(eq(schema.resumeFolder.userId, input.userId), eq(schema.resumeFolder.parentId, input.id)));
			await tx.update(schema.resume).set({ folderId: folder.parentId, updatedAt: sql`${schema.resume.updatedAt}` }).where(and(eq(schema.resume.userId, input.userId), eq(schema.resume.folderId, input.id)));
			await tx.delete(schema.resumeFolder).where(folderWhere(input.userId, input.id));
		}),
	},
	companies: {
		list: async (input: Owned<z.infer<typeof libraryDto.companies.list.input>>) => {
			const rows = await db.select({
				id: schema.companyResearch.id, company: schema.companyResearch.company, website: schema.companyResearch.website,
				summary: schema.companyResearch.summary, coreValues: schema.companyResearch.coreValues, hiringPriorities: schema.companyResearch.hiringPriorities,
				revision: schema.companyResearch.revision, createdAt: schema.companyResearch.createdAt, updatedAt: schema.companyResearch.updatedAt,
				sourceCount: sql<number>`jsonb_array_length(${schema.companyResearch.sources})`,
			}).from(schema.companyResearch).where(and(eq(schema.companyResearch.userId, input.userId), input.query ?
				ilike(sql<string>`concat_ws(' ', ${schema.companyResearch.company}, ${schema.companyResearch.summary}, ${schema.companyResearch.coreValues}, ${schema.companyResearch.hiringPriorities})`, `%${escapeLike(input.query)}%`)
			: undefined)).orderBy(schema.companyResearch.company, schema.companyResearch.id).limit(input.limit);
			return rows;
		},
		getById: async (input: Owned<{ id: string }>) => publicCompany(await ownedCompany(db, input.userId, input.id)),
		save: (input: Owned<CompanySave>) => db.transaction(async (tx) => {
			await lockDocumentOwner(tx, input.userId);
			const { userId, id, expectedRevision, ...changes } = input;
			const key = companyKey(input.company);
			const [existing] = await tx.select({ id: schema.companyResearch.id }).from(schema.companyResearch).where(and(eq(schema.companyResearch.userId, userId), eq(schema.companyResearch.companyKey, key)));
			if (existing && existing.id !== id) throw new ORPCError("CONFLICT", { message: "Research for this company already exists. Read it and update that document instead." });
			if (id) {
				const current = await ownedCompany(tx, userId, id);
				if (current.revision !== expectedRevision) throw new ORPCError("CONFLICT", { message: "Company research changed. Read the latest revision, merge your notes, and save again." });
				const [updated] = await tx.update(schema.companyResearch).set({ ...changes, companyKey: key, revision: current.revision + 1 }).where(and(companyWhere(userId, id), eq(schema.companyResearch.revision, expectedRevision!))).returning();
				if (!updated) throw new ORPCError("CONFLICT");
				return publicCompany(updated);
			}
			const [created] = await tx.insert(schema.companyResearch).values({ ...changes, userId, companyKey: key }).returning();
			if (!created) throw new ORPCError("INTERNAL_SERVER_ERROR");
			return publicCompany(created);
		}),
		delete: (input: Owned<{ id: string; expectedRevision: number }>) => db.transaction(async (tx) => {
			await lockDocumentOwner(tx, input.userId);
			const current = await ownedCompany(tx, input.userId, input.id);
			if (current.revision !== input.expectedRevision) throw new ORPCError("CONFLICT", { message: "Company research changed. Read it again before deleting." });
			await tx.delete(schema.companyResearch).where(companyWhere(input.userId, input.id));
		}),
	},
	resumes: {
		getMetadata: (input: Owned<{ resumeId: string }>) => metadata(db, input.userId, input.resumeId),
		setMetadata: (input: Owned<MetadataUpdate>) => db.transaction(async (tx) => {
			await lockDocumentOwner(tx, input.userId);
			const current = await metadata(tx, input.userId, input.resumeId, "update");
			// Organizing is allowed for locked resumes; factual content and LaTeX source are never written here.
			if (input.folderId) await ownedFolder(tx, input.userId, input.folderId);
			if (input.companyId) await ownedCompany(tx, input.userId, input.companyId);
			if (input.sourceResumeId) {
				const visited = new Set([input.resumeId]);
				let sourceId: string | null = input.sourceResumeId;
				while (sourceId !== null) {
					if (visited.has(sourceId)) throw new ORPCError("BAD_REQUEST", { message: "A resume cannot derive from itself." });
					if (visited.size > 50) throw new ORPCError("BAD_REQUEST", { message: "Resume source chain is too long." });
					visited.add(sourceId);
					sourceId = (await metadata(tx, input.userId, sourceId)).sourceResumeId;
				}
			}
			const sourceResumeId = input.sourceResumeId === undefined ? current.sourceResumeId : input.sourceResumeId;
			// A supplied source review snapshot is checked under a row lock, including concurrent source edits.
			const source = input.profile?.reviewedSourceUpdatedAt && sourceResumeId
				? await metadata(tx, input.userId, sourceResumeId, "share") : null;
			const evidenceIds = [...new Set(input.profile?.requirementEvidence?.flatMap((item) => item.evidence.map((evidence) => evidence.resumeId)) ?? [])];
			if (evidenceIds.length > 0) {
				const ownedEvidence = await tx.select({ id: schema.resume.id }).from(schema.resume).where(and(
					eq(schema.resume.userId, input.userId), inArray(schema.resume.id, evidenceIds), isNull(schema.resume.trashedAt),
				));
				if (ownedEvidence.length !== evidenceIds.length) throw new ORPCError("NOT_FOUND", { message: "An evidence source resume is unavailable or not owned by this account." });
			}
			const profile = mergeResumeProfile(current.profile, input.profile ?? {}, {
				resumeUpdatedAt: current.updatedAt, sourceUpdatedAt: source?.updatedAt ?? null,
				companyChanged: input.companyId !== undefined && input.companyId !== current.companyId,
				sourceChanged: input.sourceResumeId !== undefined && input.sourceResumeId !== current.sourceResumeId,
				now: new Date(),
			});
			await tx.update(schema.resume).set({
				profile,
				...(input.folderId !== undefined ? { folderId: input.folderId } : {}),
				...(input.sourceResumeId !== undefined ? { sourceResumeId: input.sourceResumeId } : {}),
				...(input.companyId !== undefined ? { companyId: input.companyId } : {}),
				updatedAt: current.updatedAt,
			}).where(resumeWhere(input.userId, input.resumeId));
			return metadata(tx, input.userId, input.resumeId);
		}),
		index: async (input: Owned<IndexInput>) => {
			if (input.folderId) await ownedFolder(db, input.userId, input.folderId);
			if (input.companyId) await ownedCompany(db, input.userId, input.companyId);
			const search = searchTerms([input.query, input.company, input.targetRole, ...(input.keywords ?? [])]);
			const text = sql<string>`concat_ws(' ', ${schema.resume.name}, ${schema.resume.tags}, ${schema.resume.profile}->>'company', ${schema.resume.profile}->>'targetRole', ${schema.resume.profile}->>'keywords', ${schema.resume.profile}->>'reuseNotes', ${schema.application.company}, ${schema.application.role})`;
			const searchPredicates = search.map((term) => ilike(text, `%${escapeLike(term)}%`));
			const relevance = searchPredicates.length > 0 ? sql<number>`${sql.join(searchPredicates.map((predicate) => sql`case when ${predicate} then 1 else 0 end`), sql` + `)}` : sql<number>`0`;
			const rows = await db.select({
				id: schema.resume.id, name: schema.resume.name, tags: schema.resume.tags, folderId: schema.resume.folderId,
				sourceResumeId: schema.resume.sourceResumeId, companyId: schema.resume.companyId, updatedAt: schema.resume.updatedAt,
				// Do not pull printable source, pasted job descriptions, or long score explanations into an index.
				profile: sql<Partial<schema.ResumeProfile>>`(${schema.resume.profile} - 'jobDescription' - 'scoreNotes' - 'rubric' - 'jobUrl' - 'requirementEvidence' - 'tailoringChanges' - 'outcome') || jsonb_build_object('outcome', coalesce(${schema.resume.profile}->'outcome', '{}'::jsonb) - 'notes')`,
				applicationId: schema.application.id, company: schema.application.company, role: schema.application.role, status: schema.application.status,
			}).from(schema.resume).leftJoin(schema.application, and(eq(schema.resume.applicationId, schema.application.id), eq(schema.application.userId, input.userId))).where(and(
				eq(schema.resume.userId, input.userId), isNull(schema.resume.trashedAt),
				input.folderId === undefined ? undefined : input.folderId === null ? isNull(schema.resume.folderId) : eq(schema.resume.folderId, input.folderId),
				input.companyId ? eq(schema.resume.companyId, input.companyId) : undefined,
				input.purpose ? sql`coalesce(${schema.resume.profile}->>'purpose', 'general') = ${input.purpose}` : undefined,
				searchPredicates.length > 0 ? or(...searchPredicates) : undefined,
			)).orderBy(desc(relevance), desc(schema.resume.updatedAt), schema.resume.id).limit(Math.min(500, input.limit * 5));
			const sourceIds = [...new Set(rows.flatMap((row) => row.sourceResumeId ? [row.sourceResumeId] : []))];
			const sources = sourceIds.length === 0 ? [] : await db.select({ id: schema.resume.id, updatedAt: schema.resume.updatedAt }).from(schema.resume).where(and(eq(schema.resume.userId, input.userId), inArray(schema.resume.id, sourceIds), isNull(schema.resume.trashedAt)));
			const sourceDates = new Map(sources.map((source) => [source.id, source.updatedAt]));
			const applications = rows.length === 0 ? [] : await db.select({
				resumeId: schema.application.resumeId, status: schema.application.status,
				closedReason: schema.application.closedReason, sentResumeVersionId: schema.application.sentResumeVersionId,
				sentResumeId: schema.resumeVersion.resumeId,
				updatedAt: schema.application.updatedAt,
				activityStages: sql<string[]>`coalesce((select jsonb_agg(distinct event->>'stage') from jsonb_array_elements(${schema.application.activity}) as event where event->>'type' = 'stage'), '[]'::jsonb)`,
			}).from(schema.application).leftJoin(schema.resumeVersion, and(
				eq(schema.application.sentResumeVersionId, schema.resumeVersion.id), eq(schema.resumeVersion.userId, input.userId),
			)).where(and(eq(schema.application.userId, input.userId), inArray(schema.application.resumeId, rows.map((row) => row.id))));
			return rows.map((row) => {
				const profile = resumeProfileSchema.parse(row.profile);
				const sourceUpdatedAt = row.sourceResumeId ? sourceDates.get(row.sourceResumeId) ?? null : null;
				return rankResume({
					id: row.id, name: row.name, tags: row.tags, folderId: row.folderId, sourceResumeId: row.sourceResumeId,
					sourceUpdatedAt,
					companyId: row.companyId, company: profile.company || row.company || "", targetRole: profile.targetRole || row.role || "",
					purpose: profile.purpose, keywords: profile.keywords, reuseNotes: profile.reuseNotes.slice(0, 350), score: profile.score,
					evaluatedAt: profile.evaluatedAt, evaluationStale: evaluationStale(profile, row.updatedAt), updatedAt: row.updatedAt,
					...reviewFreshness(profile, row.updatedAt, row.sourceResumeId, sourceUpdatedAt),
					outcome: resolveResumeOutcome(row.id, profile.outcome, applications),
					application: row.applicationId ? { id: row.applicationId, company: row.company ?? "", role: row.role ?? "", status: row.status ?? "saved" } : null,
				}, input);
			}).sort((a, b) => b.reusePriority - a.reusePriority || b.similarity - a.similarity || b.updatedAt.getTime() - a.updatedAt.getTime()).slice(0, input.limit);
		},
	},
	jobs: {
		index: async (input: Owned<z.infer<typeof libraryDto.jobs.index.input>>) => {
			const search = searchTerms([input.query, input.company, input.targetRole, ...(input.keywords ?? [])]);
			const text = sql<string>`concat_ws(' ', ${schema.application.company}, ${schema.application.role}, ${schema.application.requirements}, ${schema.application.tags}, ${schema.application.jobDescription})`;
			const predicates = search.map((term) => ilike(text, `%${escapeLike(term)}%`));
			const relevance = predicates.length > 0 ? sql<number>`${sql.join(predicates.map((predicate) => sql`case when ${predicate} then 1 else 0 end`), sql` + `)}` : sql<number>`0`;
			const rows = await db.select({
				id: schema.application.id, company: schema.application.company, role: schema.application.role, status: schema.application.status,
				sourceUrl: schema.application.sourceUrl, requirements: schema.application.requirements, tags: schema.application.tags,
				resumeId: schema.application.resumeId, sentResumeVersionId: schema.application.sentResumeVersionId,
				descriptionSnippet: sql<string>`coalesce(left(${schema.application.jobDescription}, 350), '')`,
				updatedAt: schema.application.updatedAt,
			}).from(schema.application).where(and(eq(schema.application.userId, input.userId), predicates.length > 0 ? or(...predicates) : undefined))
				.orderBy(desc(relevance), desc(schema.application.updatedAt), schema.application.id).limit(Math.min(500, input.limit * 5));
			return rows.map((row) => {
				const ranked = rankResume({
					id: row.id, name: row.role, company: row.company, targetRole: row.role, purpose: "tailored", keywords: row.requirements,
					tags: row.tags, reuseNotes: "", folderId: null, sourceResumeId: null, companyId: null, sourceUpdatedAt: null,
					score: null, evaluatedAt: null, evaluationStale: false, updatedAt: row.updatedAt, application: null,
					reviewStale: false, sourceStale: false,
					outcome: { stage: "not_applied", recordedAt: null, strongestStage: "not_applied", source: "none" },
				}, input);
				return { ...row, requirements: row.requirements.slice(0, 20).map((value) => value.slice(0, 200)), similarity: ranked.similarity };
			}).sort((a, b) => b.similarity - a.similarity || b.updatedAt.getTime() - a.updatedAt.getTime()).slice(0, input.limit);
		},
	},
};
