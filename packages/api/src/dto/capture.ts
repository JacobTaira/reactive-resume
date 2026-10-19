import z from "zod";
import {
	applicationCaptureSchema,
	applicationPreparationSchema,
	preparationStateSchema,
} from "@reactive-resume/schema/applications/data";

const id = z.string().trim().min(1).max(100);
const url = z.url({
	protocol: /^https?$/
}).max(4000);
export const captureInputSchema = z.strictObject({
	url,
	canonicalUrl: url.optional(),
	title: z.string().trim().max(500).default(""),
	company: z.string().trim().max(300).default(""),
	role: z.string().trim().max(300).default(""),
	location: z.string().trim().max(500).default(""),
	description: z.string().max(250_000).default(""),
	format: z.enum(["text", "markdown"]).default("text"),
	requirements: z.array(z.string().trim().max(2000)).max(100).default([]),
	extraction: z.enum(["jsonld", "adapter", "text"]),
	capturedAt: z.iso.datetime({
		offset: true
	}),
	companyFallback: z.boolean().default(false),
	roleFallback: z.boolean().default(false),
	descriptionIncomplete: z.boolean().default(false),
	providerId: z.string().trim().max(300).optional(),
	clientCaptureId: z.string().trim().min(1).max(100).optional()
});
export const captureResultSchema = z.object({
	id,
	result: z.enum(["created", "duplicate"]),
	possibleDuplicateOf: id.optional(),
	appUrl: url,
	state: preparationStateSchema,
	applicationStatus: z.string(),
	warnings: z.array(z.string())
});
export const queueItemSchema = z.object({
	id,
	company: z.string(),
	role: z.string(),
	location: z.string().nullable(),
	sourceUrl: z.string().nullable(),
	applicationStatus: z.string(),
	capturedAt: z.string().nullable(),
	createdAt: z.string(),
	descriptionLength: z.number().int(),
	truncated: z.boolean(),
	capture: applicationCaptureSchema.nullable(),
	preparation: applicationPreparationSchema,
	description: z.string().optional(),
	contentWarning: z.string()
});
const revisionInput = {
	id,
	expectedRevision: z.number().int().nonnegative()
};
const leaseToken = z.string().min(20).max(200);
export const captureDto = {
	capture: {
		input: captureInputSchema,
		output: captureResultSchema
	},
	batch: {
		// Validate each item inside the handler so one malformed capture cannot reject the batch.
		input: z.strictObject({
			items: z.array(z.unknown()).min(1).max(50)
		}),
		output: z.object({
			results: z.array(z.object({
				index: z.number().int(),
				clientCaptureId: z.string().optional(),
				result: captureResultSchema.optional(),
				error: z.object({
					code: z.string(),
					message: z.string()
				}).optional()
			}))
		})
	},
	status: {
		input: z.object({}).default({}),
		output: z.object({
			connected: z.literal(true),
			captureAllowed: z.literal(true),
			version: z.literal(1)
		})
	}
};
export const queueDto = {
	list: {
		input: z.object({
			states: z.array(preparationStateSchema).max(6).optional(),
			query: z.string().trim().max(500).optional(),
			limit: z.number().int().min(1).max(100).default(30),
			offset: z.number().int().min(0).default(0),
			includeDescription: z.boolean().default(false)
		}).default({
			limit: 30,
			offset: 0,
			includeDescription: false
		}),
		output: z.object({
			items: z.array(queueItemSchema),
			total: z.number().int(),
			counts: z.object({
				pending: z.number().int(),
				needs_details: z.number().int(),
				processing: z.number().int(),
				ready: z.number().int(),
				failed: z.number().int(),
				skipped: z.number().int()
			}),
			nextOffset: z.number().int().nullable()
		})
	},
	read: {
		input: z.object({
			id,
			includeDescription: z.boolean().default(true)
		}),
		output: queueItemSchema
	},
	update: {
		input: z.strictObject({
			...revisionInput,
			state: z.enum(["pending", "needs_details", "failed"]).optional(),
			company: z.string().trim().min(1).max(300).optional(),
			role: z.string().trim().min(1).max(300).optional(),
			description: z.string().max(20_000).optional(),
			notes: z.string().max(5000).optional(),
			draftResumeId: id.nullable().optional(),
			leaseToken: leaseToken.optional()
		}),
		output: queueItemSchema
	},
	claim: {
		input: z.strictObject({
			...revisionInput,
			leaseSeconds: z.number().int().min(60).max(1800).default(900),
			leaseToken: leaseToken.optional()
		}),
		output: z.object({
			item: queueItemSchema,
			leaseToken
		})
	},
	finish: {
		input: z.strictObject({
			...revisionInput,
			leaseToken,
			outcome: z.enum(["ready", "failed"]),
			draftResumeId: id.optional(),
			expectedResumeUpdatedAt: z.iso.datetime({
				offset: true
			}).optional(),
			verifyPdf: z.literal(true).optional().describe(
				"Compile and check the saved LaTeX draft on the server before completing preparation. Requires expectedResumeUpdatedAt; no score or review metadata is required.",
			),
			expectedPageCount: z.number().int().min(1).max(100).optional(),
			score: z.number().int().min(0).max(100).optional().describe(
				"Optional heuristic assessment saved for the server-verified draft. Requires verifyPdf=true; it is never an ATS guarantee.",
			),
			error: z.string().max(2000).optional(),
			notes: z.string().max(5000).optional()
		}),
		output: queueItemSchema.extend({
			pdfVerification: z.object({
				pageCount: z.number().int().positive(),
				overfullBoxes: z.object({
					count: z.number().int().nonnegative(),
					messages: z.array(z.string().max(500)).max(20),
					truncated: z.boolean(),
				}),
				textExtractionStatus: z.literal("success"),
			}).optional(),
		}),
	},
	action: {
		input: z.strictObject({
			...revisionInput,
			action: z.enum(["skip", "requeue"])
		}),
		output: queueItemSchema
	}
};
export type CaptureInput = z.infer<typeof captureInputSchema>;
export type CaptureResult = z.infer<typeof captureResultSchema>;
export type QueueItem = z.infer<typeof queueItemSchema>;
