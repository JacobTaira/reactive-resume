import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";
import { env } from "@reactive-resume/env/server";
import { generateId } from "@reactive-resume/utils/string";
import { captureInputSchema, type CaptureInput, type CaptureResult } from "../../dto/capture";
import {
	canonicalPostingUrl,
	cleanCaptureText,
	initialPreparation,
	normalizedJobLabel,
	prepareCapture,
} from "./capture-policy";

export const captureService = {
	capture: (userId: string, input: CaptureInput): Promise<CaptureResult> => {
		const now = new Date();
		const prepared = prepareCapture(input, now);
		const identity = createHash("sha256").update(prepared.identity).digest("hex");
		return db.transaction(async tx => {
			// The same owner lock is used by existing application create/update/delete writers.
			const [owner] = await tx.select({
				id: schema.user.id
			})
				.from(schema.user)
				.where(eq(schema.user.id, userId))
				.for("no key update");
			if (!owner) throw new ORPCError("NOT_FOUND");
			const existing = await tx.select({
				id: schema.application.id,
				sourceUrl: schema.application.sourceUrl,
				captureIdentity: schema.application.captureIdentity,
				capture: schema.application.capture,
				preparation: schema.application.preparation,
				status: schema.application.status,
				company: schema.application.company,
				role: schema.application.role,
				jobDescription: schema.application.jobDescription,
				tags: schema.application.tags,
				createdAt: schema.application.createdAt
			})
				.from(schema.application)
				.where(eq(schema.application.userId, userId))
				.orderBy(asc(schema.application.createdAt), asc(schema.application.id));
			const duplicate = existing.find(row => {
				if (row.captureIdentity === identity || row.capture?.canonicalUrl === prepared.canonicalUrl) return true;
				if (!row.sourceUrl) return false;
				try {
					return canonicalPostingUrl(row.sourceUrl) === prepared.canonicalUrl;
				} catch {
					return false;
				}
			});
			const appUrl = (id: string) =>
				`${env.APP_URL.replace(/\/$/, "")}/dashboard/applications?applicationId=${encodeURIComponent(id)}`;
			if (duplicate) {
				const state = initialPreparation(duplicate, now).state;
				return {
					id: duplicate.id,
					result: "duplicate",
					appUrl: appUrl(duplicate.id),
					state,
					applicationStatus: duplicate.status,
					warnings: [
						...(duplicate.status !== "saved"
							? [`Already tracked with status ${duplicate.status}; existing record was preserved.`]
							: []),
						...(state === "needs_details"
							? ["Existing entry needs repair in Applications. Capture never overwrites its saved description or details; " +
								"copy the captured text into that entry."]
							: []),
					]
				};
			}
			const possibleDuplicate = existing.find((row) =>
				normalizedJobLabel(row.company) === normalizedJobLabel(prepared.company) &&
				normalizedJobLabel(row.role) === normalizedJobLabel(prepared.role),
			);
			const id = generateId();
			await tx.insert(schema.application).values({
				id,
				userId,
				company: prepared.company,
				role: prepared.role,
				location: cleanCaptureText(input.location) || null,
				source: new URL(prepared.canonicalUrl).hostname.replace(/^www\./, ""),
				sourceUrl: prepared.canonicalUrl,
				jobDescription: prepared.description,
				status: "saved",
				captureIdentity: identity,
				capture: prepared.capture,
				preparation: prepared.preparation,
				postingSource: {
					method: "extension",
					format: input.format,
					requestedUrl: canonicalPostingUrl(input.url),
					resolvedUrl: prepared.canonicalUrl,
					retrievedAt: input.capturedAt,
					truncated: prepared.truncated,
					completeness: prepared.preparation.state === "needs_details" || prepared.truncated ? "incomplete" : "unknown"
				},
				requirements: input.requirements.map(cleanCaptureText).filter(Boolean),
				activity: [{
					id: generateId(),
					type: "stage",
					stage: "saved",
					at: now
				}],
				appliedAt: now,
				createdAt: now,
				updatedAt: now
			});
			return {
				id,
				result: "created",
				...(possibleDuplicate ? {
					possibleDuplicateOf: possibleDuplicate.id
				} : {}),
				appUrl: appUrl(id),
				state: prepared.preparation.state,
				applicationStatus: "saved",
				warnings: prepared.warnings
			};
		});
	},
	batch: async (userId: string, items: unknown[]) => {
		const results: {
			index: number;
			clientCaptureId?: string;
			result?: CaptureResult;
			error?: {
				code: string;
				message: string;
			};
		}[] = [];
		for (const [index, item] of items.entries()) {
			const parsed = captureInputSchema.safeParse(item);
			const clientCaptureId =
				item && typeof item === "object" && "clientCaptureId" in item && typeof item.clientCaptureId === "string"
					? item.clientCaptureId.slice(0, 100)
					: undefined;
			if (!parsed.success) {
				results.push({
					index,
					...(clientCaptureId ? {
						clientCaptureId
					} : {}),
					error: {
						code: "INVALID_INPUT",
						message: parsed.error.issues.slice(0, 5).map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")
					}
				});
				continue;
			}
			try {
				results.push({
					index,
					...(clientCaptureId ? {
						clientCaptureId
					} : {}),
					result: await captureService.capture(userId, parsed.data)
				});
			} catch (error) {
				results.push({
					index,
					...(clientCaptureId ? {
						clientCaptureId
					} : {}),
					error: {
						code: error instanceof ORPCError ? error.code : "CAPTURE_FAILED",
						message: error instanceof ORPCError ? error.message : "Capture could not be saved. Retry this item."
					}
				});
			}
		}
		return {
			results
		};
	}
};
