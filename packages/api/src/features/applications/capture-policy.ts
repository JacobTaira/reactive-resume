import type { ApplicationCapture, ApplicationPreparation } from "@reactive-resume/schema/applications/data";
import type { CaptureInput } from "../../dto/capture";

export const MAX_CAPTURE_DESCRIPTION = 20_000;
const trackingParameter = /^(?:utm_.+|fbclid|gclid|msclkid|mc_cid|mc_eid)$/i;

/** Normalize identity on the server too. Keep functional query parameters (for example gh_jid). */
export function canonicalPostingUrl(value: string): string {
	const parsed = new URL(value);
	if (!/^https?:$/.test(parsed.protocol)) throw new Error("Posting URL must use HTTP or HTTPS.");
	parsed.username = "";
	parsed.password = "";
	// Generic sites can put a functional job identifier in their hash route.
	const isJobright = /^(?:www\.)?jobright\.ai$/i.test(parsed.hostname);
	if (isJobright) parsed.hash = "";
	for (const key of [...parsed.searchParams.keys()]) {
		if (trackingParameter.test(key) || (isJobright && key === "visit")) parsed.searchParams.delete(key);
	}
	parsed.searchParams.sort();
	parsed.hostname = parsed.hostname.toLowerCase();
	if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, "");
	return parsed.toString();
}

export function postingIdentity(url: string, providerId?: string): string {
	const parsed = new URL(canonicalPostingUrl(url));
	const jobright = /^(?:www\.)?jobright\.ai$/i.test(parsed.hostname) && /^\/jobs\/info\/([^/]+)$/.exec(parsed.pathname);
	if (jobright) return `jobright:${jobright[1]}`;
	// A provider ID is always scoped to the actual source hostname.
	if (providerId?.trim()) return `${parsed.hostname}:id:${providerId.trim().slice(0, 300)}`;
	return `url:${parsed.toString()}`;
}

/** Bounded plain text/Markdown: raw HTML and active page content are never retained. */
export function cleanCaptureText(value: string): string {
	return value
		.replace(/\r\n?/g, "\n")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<(script|style|iframe|object|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
		.replace(/<\/?[a-z][^>]*>/gi, "")
		.trim();
}

export const normalizedJobLabel = (value: string) =>
	value.trim().normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/g, " ");

export function prepareCapture(input: CaptureInput, now: Date) {
	const originalUrl = canonicalPostingUrl(input.url);
	const candidate = input.canonicalUrl ? canonicalPostingUrl(input.canonicalUrl) : originalUrl;
	// A page cannot assign another origin's capture identity through a hostile canonical element.
	const originalIdentity = postingIdentity(originalUrl);
	const canonicalHasSameOrigin = new URL(candidate).origin === new URL(originalUrl).origin;
	const canonicalPreservesKnownJob =
		!originalIdentity.startsWith("jobright:") || postingIdentity(candidate) === originalIdentity;
	const canonicalUrl = canonicalHasSameOrigin && canonicalPreservesKnownJob ? candidate : originalUrl;
	const description = cleanCaptureText(input.description);
	const cleanedCompany = cleanCaptureText(input.company);
	const cleanedRole = cleanCaptureText(input.role);
	const companyFallback = input.companyFallback || !cleanedCompany;
	const roleFallback = input.roleFallback || !cleanedRole;
	const company = cleanedCompany || "Unknown company";
	const role = cleanedRole || cleanCaptureText(input.title).slice(0, 300) || "Unknown role";
	const capture: ApplicationCapture = {
		canonicalUrl,
		capturedAt: input.capturedAt,
		extraction: input.extraction,
		companyFallback,
		roleFallback,
		providerId: input.providerId ?? null
	};
	const preparation: ApplicationPreparation = {
		state: companyFallback || roleFallback || !description ? "needs_details" : "pending",
		revision: 1,
		draftResumeId: null,
		notes: "",
		error: "",
		leaseExpiresAt: null,
		updatedAt: now.toISOString()
	};
	return {
		canonicalUrl,
		identity: postingIdentity(canonicalUrl, input.providerId),
		company,
		role,
		capture,
		preparation,
		description: description.slice(0, MAX_CAPTURE_DESCRIPTION),
		truncated: description.length > MAX_CAPTURE_DESCRIPTION,
		warnings: [
			...(companyFallback ? ["Company needs confirmation."] : []),
			...(roleFallback ? ["Role needs confirmation."] : []),
			...(!description ? ["Description is missing; saved under Needs details."] : []),
			...(description.length > MAX_CAPTURE_DESCRIPTION ? ["Description was truncated to 20,000 characters."] : []),
		]
	};
}

export function initialPreparation(row: {
	preparation: ApplicationPreparation | null;
	capture: ApplicationCapture | null;
	company: string;
	role: string;
	jobDescription: string | null;
	tags: string[];
	createdAt: Date;
}, now = new Date()): ApplicationPreparation {
	if (row.preparation) {
		if (row.tags.includes("skip")) return {
			...row.preparation,
			state: "skipped",
			leaseExpiresAt: null
		};
		if (
			row.preparation.state === "processing" &&
			(!row.preparation.leaseExpiresAt || new Date(row.preparation.leaseExpiresAt) <= now)
		) {
			return {
				...row.preparation,
				state: "failed",
				error: "Processing lease expired. The saved job and draft remain available.",
				leaseExpiresAt: null
			};
		}
		return row.preparation;
	}
	return {
		state: row.tags.includes("skip")
			? "skipped"
			: row.tags.includes("needs-details") || row.tags.includes("needs_details") || !hasCaptureDetails(row)
				? "needs_details"
				: "pending",
		revision: 0,
		draftResumeId: null,
		notes: "",
		error: "",
		leaseExpiresAt: null,
		updatedAt: row.createdAt.toISOString()
	};
}

export function hasCaptureDetails(row: {
	company: string;
	role: string;
	jobDescription: string | null;
	capture: ApplicationCapture | null;
}) {
	return Boolean(
		row.company.trim() && row.role.trim() && row.jobDescription?.trim() &&
		!row.capture?.companyFallback && !row.capture?.roleFallback,
	);
}
