export const MAX_PENDING = 250;
export const MAX_BYTES = 6 * 1024 * 1024;

export function captureBody(payload, clientCaptureId) {
	return {
		url: payload.url, canonicalUrl: payload.canonicalUrl || payload.url,
		title: String(payload.title || "").slice(0, 500), company: String(payload.company || "").slice(0, 200),
		role: String(payload.role || "").slice(0, 300), location: String(payload.location || "").slice(0, 300),
		description: String(payload.description || "").slice(0, 250000), format: "text",
		requirements: (payload.requirements || []).slice(0, 100).map((item) => String(item).slice(0, 2000)),
		extraction: ["jsonld", "adapter"].includes(payload.extraction) ? payload.extraction : "text",
		capturedAt: payload.capturedAt || new Date().toISOString(),
		companyFallback: Boolean(payload.companyFallback), roleFallback: Boolean(payload.roleFallback),
		clientCaptureId,
	};
}

export function addCapture(items, payload, id, now = Date.now()) {
	const body = captureBody(payload, id);
	const existing = items.find((item) => item.body.canonicalUrl === body.canonicalUrl && item.status !== "saved");
	if (existing) {
		const descriptionImproved = !existing.body.description.trim() && Boolean(body.description.trim());
		const companyImproved = existing.body.companyFallback && !body.companyFallback;
		const roleImproved = existing.body.roleFallback && !body.roleFallback;
		if (descriptionImproved || companyImproved || roleImproved) {
			const upgraded = { ...existing, status: "waiting", attempts: 0, nextAttemptAt: now, error: "",
				warnings: Array.isArray(payload.warnings) ? payload.warnings.map(String).slice(0, 20) : [],
				body: { ...existing.body, ...body, clientCaptureId: existing.body.clientCaptureId,
					description: descriptionImproved ? body.description : existing.body.description,
					company: companyImproved ? body.company : existing.body.company, companyFallback: companyImproved ? false : existing.body.companyFallback,
					role: roleImproved ? body.role : existing.body.role, roleFallback: roleImproved ? false : existing.body.roleFallback } };
			const next = items.map((item) => item.id === existing.id ? upgraded : item);
			if (new TextEncoder().encode(JSON.stringify(next)).length > MAX_BYTES) throw new Error("Local storage is full; the improved capture was not saved. Sync or remove items and try again.");
			return { items: next, item: upgraded, existing: true };
		}
		return { items, item: existing, existing: true };
	}
	if (items.filter((item) => item.status !== "saved").length >= MAX_PENDING) throw new Error("The local capture outbox is full. Sync or remove items before capturing more jobs.");
	const item = { id, body, status: "waiting", attempts: 0, nextAttemptAt: now, createdAt: now,
		warnings: Array.isArray(payload.warnings) ? payload.warnings.map(String).slice(0, 20) : [], error: "" };
	// Retain the most recent confirmed items for inspection; never discard pending or failed captures.
	const pending = items.filter((entry) => entry.status !== "saved");
	const history = items.filter((entry) => entry.status === "saved").slice(-100);
	const next = [...history, ...pending, item];
	if (new TextEncoder().encode(JSON.stringify(next)).length > MAX_BYTES) throw new Error("Local capture storage is nearly full. Sync or remove items; this job has not been captured.");
	return { items: next, item, existing: false };
}

export function dueCaptures(items, now = Date.now()) {
	return items.filter((item) => (item.status === "waiting" || item.status === "sending") && item.nextAttemptAt <= now).slice(0, 20);
}

export function captureSucceeded(item, result, now = Date.now()) {
	if (!result?.id || !["created", "duplicate"].includes(result.result)) throw new Error("The server did not confirm an application ID.");
	const needsRepair = result.state === "needs_details";
	return { ...item, status: needsRepair ? "attention" : "saved", savedAt: now, result, error: "",
		warnings: [...new Set([...item.warnings, ...(result.warnings || [])])],
		// A duplicate needs-details application may have an empty description. Retain the full
		// capture for manual repair; capture-only keys deliberately cannot edit applications.
		body: { ...item.body, description: needsRepair ? item.body.description : item.body.description.slice(0, 300) } };
}

export function captureFailed(item, message, permanent = false, now = Date.now()) {
	const attempts = item.attempts + 1;
	return { ...item, attempts, status: permanent || attempts >= 8 ? "failed" : "waiting", error: String(message).slice(0, 500),
		nextAttemptAt: now + Math.min(30 * 60 * 1000, 5000 * 2 ** Math.min(attempts - 1, 9)) };
}

export function normalizedBaseUrl(input) {
	const url = new URL(String(input).trim());
	if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
		throw new Error("Enter the installation origin, such as http://localhost:3000, without a path or login information.");
	}
	if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
		throw new Error("Use HTTPS, or HTTP on localhost/127.0.0.1 for your local installation.");
	}
	return url.origin;
}
