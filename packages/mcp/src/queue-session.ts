import type { RouterClient } from "@orpc/server";
import type router from "@reactive-resume/api/routers";
import { ORPCError } from "@orpc/server";

type Client = RouterClient<typeof router>;
type Document = Awaited<ReturnType<Client["documents"]["list"]>>[number];
type QueueItem = Awaited<ReturnType<Client["applications"]["queue"]["read"]>>;

export type PrepareQueuedResumeInput = {
	applicationId: string;
	baseResumeId?: string | undefined;
	leaseToken?: string | undefined;
};

const normalized = (value: string) => value.trim().normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/g, " ");
const masterNames = new Set(["base resume", "master_resume", "master resume"]);
const genericTerms = new Set(["the", "and", "for", "with", "engineer", "engineering", "intern", "internship", "senior", "junior"]);
const terms = (value: string) => new Set(
	(normalized(value).match(/[\p{L}\p{N}+#.]{2,}/gu) ?? []).filter((term) => !genericTerms.has(term)),
);

function relatedCandidates(documents: Document[], item: QueueItem, baseId: string, draftId: string) {
	const wanted = terms(item.role);
	return documents.filter((document) => document.type === "resume" && !document.trashedAt &&
		document.id !== baseId && document.id !== draftId)
		.map((document) => {
			const company = document.profile?.company || document.application?.company || "";
			const targetRole = document.profile?.targetRole || document.application?.role || "";
			const existing = terms([document.name, targetRole, ...document.tags, ...(document.profile?.keywords ?? [])].join(" "));
			const matchedTerms = [...wanted].filter((term) => existing.has(term));
			const sameCompany = Boolean(company) && normalized(company) === normalized(item.company);
			return {
				id: document.id, name: document.name, updatedAt: document.updatedAt,
				sourceResumeId: document.sourceResumeId, company, targetRole,
				keywords: (document.profile?.keywords ?? []).slice(0, 12),
				matchedTerms, sameCompany, rank: (sameCompany ? 10 : 0) + matchedTerms.length,
			};
		})
		.filter((document) => document.rank > 0)
		.sort((a, b) => b.rank - a.rank || b.updatedAt.getTime() - a.updatedAt.getTime() || a.id.localeCompare(b.id))
		.slice(0, 2)
		.map(({ rank: _rank, ...document }) => document);
}

async function companyContext(client: Client, company: string, warnings: string[]) {
	try {
		const matches = await client.library.companies.list({ query: company, limit: 10 });
		const match = matches.find((entry) => normalized(entry.company) === normalized(company));
		if (!match) return [];
		const note = await client.library.companies.getById({ id: match.id });
		return [{
			id: note.id, company: note.company, revision: note.revision, updatedAt: note.updatedAt,
			summary: note.summary.slice(0, 2_000), coreValues: note.coreValues.slice(0, 12),
			hiringPriorities: note.hiringPriorities.slice(0, 12), culture: note.culture.slice(0, 2_000),
			notes: note.notes.slice(0, 6_000),
			sources: note.sources.slice(0, 10).map(({ url, title, accessedAt }) => ({ url, title, accessedAt })),
			truncated: note.summary.length > 2_000 || note.coreValues.length > 12 ||
				note.hiringPriorities.length > 12 || note.culture.length > 2_000 ||
				note.notes.length > 6_000 || note.sources.length > 10 || note.sources.some((source) => Boolean(source.notes)),
		}];
	} catch {
		warnings.push("Saved company research could not be loaded; no new company research was fetched.");
		return [];
	}
}

/** Own the claim/copy/link sequence so assistants receive the final saved timestamp, not intermediate bookkeeping. */
export async function prepareQueuedResume(client: Client, input: PrepareQueuedResumeInput) {
	const warnings: string[] = [];
	const [initialItem, documents] = await Promise.all([
		client.applications.queue.read({ id: input.applicationId, includeDescription: true }),
		client.documents.list({ trashed: false, includeProfile: false }),
	]);
	let baseId = input.baseResumeId;
	if (!baseId) {
		const bases = documents.filter((document) => document.type === "resume" && !document.trashedAt &&
			masterNames.has(normalized(document.name)));
		if (bases.length !== 1) {
			throw new ORPCError("BAD_REQUEST", {
				message: bases.length === 0
					? "Master resume was not found (Master_Resume, Master Resume or Base Resume). Specify the owned baseResumeId before preparing this job."
					: "More than one master resume candidate exists. Specify the intended owned baseResumeId before preparing this job.",
			});
		}
		baseId = bases[0]!.id;
	}
	const baseResume = await client.resume.getById({ id: baseId });
	const companies = companyContext(client, initialItem.company, warnings);
	const savedDraftId = initialItem.preparation.draftResumeId;
	const existing = documents.find((document) => document.id === savedDraftId && document.type === "resume" &&
		!document.trashedAt && document.application?.id === input.applicationId);
	if (existing && existing.sourceResumeId !== baseId) {
		throw new ORPCError("CONFLICT", {
			message: "This job already has a draft from a different base. Confirm its replacement before preparing another copy.",
		});
	}
	if (existing?.isLocked) throw new ORPCError("RESUME_LOCKED", { status: 403 });
	const claim = await client.applications.queue.claim({
		id: input.applicationId,
		expectedRevision: initialItem.preparation.revision,
		...(input.leaseToken ? { leaseToken: input.leaseToken } : {}),
	});
	let revision = claim.item.preparation.revision;
	try {
		const fullName = `${claim.item.company} — ${claim.item.role}`;
		const name = fullName.length <= 100 ? fullName : `${claim.item.company.slice(0, 48)} — ${claim.item.role.slice(0, 49)}`;
		const draftId = existing?.id ?? await client.documents.copyForJob({
			resumeId: baseResume.id, applicationId: input.applicationId, name, reuseExisting: true,
		});
		const item = await client.applications.queue.update({
			id: input.applicationId, expectedRevision: revision,
			leaseToken: claim.leaseToken, draftResumeId: draftId,
		});
		revision = item.preparation.revision;
		// All linkage and preparation writes are complete before this single authoritative draft read.
		const draft = await client.resume.getById({ id: draftId });
		if (draft.applicationId !== input.applicationId) {
			throw new ORPCError("CONFLICT", { message: "The prepared draft is no longer linked to this job. Read its current progress before retrying." });
		}
		return {
			item, draft, base: { id: baseResume.id, updatedAt: baseResume.updatedAt }, baseResume,
			leaseToken: claim.leaseToken,
			context: { related: relatedCandidates(documents, item, baseResume.id, draft.id), companies: await companies },
			warnings,
		};
	} catch (error) {
		try {
			// Release only our known claim. Omitted notes/draft fields preserve any committed copy and prior progress.
			await client.applications.queue.update({
				id: input.applicationId, expectedRevision: revision, leaseToken: claim.leaseToken, state: "failed",
			});
		} catch {
			// A concurrent write, lost response or expired claim must never be overridden to perform cleanup.
		}
		throw error;
	}
}

