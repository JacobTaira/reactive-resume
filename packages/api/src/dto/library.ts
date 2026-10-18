import z from "zod";

const idSchema = z.string().trim().min(1).max(100);
const httpUrlSchema = z.string().trim().max(2_000).pipe(z.union([z.literal(""), z.url({ protocol: /^https?$/ })]));
const labelsSchema = z.array(z.string().trim().min(1).max(120)).max(50);

export const resumeProfileSchema = z.object({
	purpose: z.enum(["general", "master", "tailored"]).default("general"),
	company: z.string().trim().max(200).default(""),
	targetRole: z.string().trim().max(200).default(""),
	keywords: labelsSchema.default([]),
	jobDescription: z.string().max(30_000).default(""),
	jobUrl: httpUrlSchema.default(""),
	reuseNotes: z.string().max(5_000).default(""),
	score: z.number().int().min(0).max(100).nullable().default(null),
	scoreNotes: z.string().max(5_000).default(""),
	rubric: z.array(z.object({
		criterion: z.string().trim().min(1).max(200),
		score: z.number().min(0).max(100),
		maxScore: z.number().positive().max(100),
		notes: z.string().max(2_000).default(""),
	}).refine((item) => item.score <= item.maxScore, "Score cannot exceed its maximum.")).max(20).default([]),
	evaluatedAt: z.iso.datetime({ offset: true }).nullable().default(null),
	evaluatedResumeUpdatedAt: z.iso.datetime({ offset: true }).nullable().default(null),
});

// Removing defaults before optional wrapping matters: a metadata patch must never reset omitted fields.
const profilePatchSchema = z.object({
	purpose: resumeProfileSchema.shape.purpose.removeDefault().optional(),
	company: resumeProfileSchema.shape.company.removeDefault().optional(),
	targetRole: resumeProfileSchema.shape.targetRole.removeDefault().optional(),
	keywords: resumeProfileSchema.shape.keywords.removeDefault().optional(),
	jobDescription: resumeProfileSchema.shape.jobDescription.removeDefault().optional(),
	jobUrl: resumeProfileSchema.shape.jobUrl.removeDefault().optional(),
	reuseNotes: resumeProfileSchema.shape.reuseNotes.removeDefault().optional(),
	score: resumeProfileSchema.shape.score.removeDefault().optional(),
	scoreNotes: resumeProfileSchema.shape.scoreNotes.removeDefault().optional(),
	rubric: resumeProfileSchema.shape.rubric.removeDefault().optional(),
	evaluatedAt: resumeProfileSchema.shape.evaluatedAt.removeDefault().optional(),
	evaluatedResumeUpdatedAt: resumeProfileSchema.shape.evaluatedResumeUpdatedAt.removeDefault().optional(),
});

const folderSchema = z.object({
	id: idSchema,
	name: z.string(),
	parentId: idSchema.nullable(),
	createdAt: z.date(),
	updatedAt: z.date(),
});

export const companyResearchSourceSchema = z.object({
	url: httpUrlSchema.refine((value) => value !== "", "A source URL is required."),
	title: z.string().trim().max(300).default(""),
	accessedAt: z.iso.datetime({ offset: true }),
	notes: z.string().max(2_000).default(""),
});

const companyEditableSchema = z.object({
	company: z.string().trim().min(1).max(200),
	website: httpUrlSchema,
	summary: z.string().max(5_000),
	coreValues: labelsSchema,
	culture: z.string().max(10_000),
	hiringPriorities: labelsSchema,
	notes: z.string().max(50_000),
	sources: z.array(companyResearchSourceSchema).max(100),
});

const companySchema = companyEditableSchema.extend({
	id: idSchema,
	revision: z.number().int().positive(),
	createdAt: z.date(),
	updatedAt: z.date(),
});

const metadataSchema = z.object({
	resumeId: idSchema,
	folderId: idSchema.nullable(),
	sourceResumeId: idSchema.nullable(),
	companyId: idSchema.nullable(),
	profile: resumeProfileSchema,
	updatedAt: z.date(),
});

export const libraryDto = {
	folders: {
		list: { input: z.object({}).default({}), output: z.array(folderSchema) },
		create: {
			input: z.object({ name: z.string().trim().min(1).max(100), parentId: idSchema.nullable().optional() }),
			output: folderSchema,
		},
		update: {
			input: z.object({ id: idSchema, name: z.string().trim().min(1).max(100).optional(), parentId: idSchema.nullable().optional() }),
			output: folderSchema,
		},
		delete: { input: z.object({ id: idSchema }), output: z.void() },
	},
	companies: {
		list: {
			input: z.object({ query: z.string().trim().max(300).optional(), limit: z.number().int().min(1).max(100).default(100) }).default({ limit: 100 }),
			output: z.array(companySchema.omit({ culture: true, notes: true, sources: true }).extend({ sourceCount: z.number() })),
		},
		getById: { input: z.object({ id: idSchema }), output: companySchema },
		save: {
			input: companyEditableSchema.partial().extend({
				id: idSchema.optional(),
				company: companyEditableSchema.shape.company,
				expectedRevision: z.number().int().positive().optional(),
			}).refine((value) => !value.id || value.expectedRevision !== undefined, "Read the company note first and provide expectedRevision when updating it."),
			output: companySchema,
		},
		delete: { input: z.object({ id: idSchema, expectedRevision: z.number().int().positive() }), output: z.void() },
	},
	resumes: {
		getMetadata: { input: z.object({ resumeId: idSchema }), output: metadataSchema },
		setMetadata: {
			input: z.object({
				resumeId: idSchema,
				folderId: idSchema.nullable().optional(),
				sourceResumeId: idSchema.nullable().optional(),
				companyId: idSchema.nullable().optional(),
				profile: profilePatchSchema.optional(),
			}),
			output: metadataSchema,
		},
		index: {
			input: z.object({
				query: z.string().trim().max(500).optional(),
				company: z.string().trim().max(200).optional(),
				companyId: idSchema.optional(),
				targetRole: z.string().trim().max(200).optional(),
				keywords: labelsSchema.optional(),
				purpose: resumeProfileSchema.shape.purpose.removeDefault().optional(),
				folderId: idSchema.nullable().optional(),
				limit: z.number().int().min(1).max(100).default(30),
			}).default({ limit: 30 }),
			output: z.array(z.object({
				id: idSchema,
				name: z.string(),
				folderId: idSchema.nullable(),
				sourceResumeId: idSchema.nullable(),
				sourceUpdatedAt: z.date().nullable(),
				companyId: idSchema.nullable(),
				company: z.string(),
				targetRole: z.string(),
				purpose: z.enum(["general", "master", "tailored"]),
				keywords: z.array(z.string()),
				tags: z.array(z.string()),
				reuseNotes: z.string(),
				score: z.number().nullable(),
				evaluatedAt: z.string().nullable(),
				evaluationStale: z.boolean(),
				updatedAt: z.date(),
				application: z.object({ id: idSchema, company: z.string(), role: z.string(), status: z.string() }).nullable(),
				similarity: z.number().min(0).max(100),
				reuseHints: z.array(z.string()),
			})),
		},
	},
	jobs: {
		index: {
			input: z.object({
				query: z.string().trim().max(500).optional(),
				company: z.string().trim().max(200).optional(),
				targetRole: z.string().trim().max(200).optional(),
				keywords: labelsSchema.optional(),
				limit: z.number().int().min(1).max(100).default(30),
			}).default({ limit: 30 }),
			output: z.array(z.object({
				id: idSchema, company: z.string(), role: z.string(), status: z.string(),
				sourceUrl: z.string().nullable(), requirements: z.array(z.string()), tags: z.array(z.string()),
				resumeId: idSchema.nullable(), sentResumeVersionId: idSchema.nullable(),
				descriptionSnippet: z.string(), updatedAt: z.date(), similarity: z.number().min(0).max(100),
			})),
		},
	},
};

export type ResumeProfile = z.infer<typeof resumeProfileSchema>;
export type ResumeFolder = z.infer<typeof folderSchema>;
export type CompanyResearch = z.infer<typeof companySchema>;
export type ResumeLibraryMetadata = z.infer<typeof metadataSchema>;
export type ResumeIndexEntry = z.infer<typeof libraryDto.resumes.index.output>[number];
