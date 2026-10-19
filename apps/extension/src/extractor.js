/* Also loaded as a classic isolated-world content script. No page JavaScript is evaluated. */
(() => {
	function canonicalUrl(value, base) {
		const url = new URL(value || base, base);
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
			throw new Error("Only HTTP(S) job URLs are supported.");
		}
		for (const key of [...url.searchParams.keys()]) {
			if (/^(utm_.+|fbclid|gclid|msclkid|mc_cid|mc_eid)$/i.test(key)) url.searchParams.delete(key);
			if (url.hostname === "jobright.ai" && key === "visit") url.searchParams.delete(key);
		}
		// Query parameters and hash routes can identify different jobs. Preserve them by default.
		return url.href;
	}
	const sectionTitle = /^(responsibilities|qualifications?|requirements?|preferred qualifications?|about (the )?(job|role)|job description):?$/i;
	const descriptionChrome = /^(responsibilities|qualifications?|requirements?|required|preferred|preferred qualifications?|about (the )?(job|role)|job description|represents the skills you have|skills you have|apply now|apply on employer site|overview|company|loading[.\s…]*):?$/i;
	// Jobright's editable skill matches describe its UI, not employer requirements or candidate evidence.
	const jobrightGuidance = /(?:Find out how your skills align with this job['’]s requirements\.|If anything seems off,\s*you can easily click on the tags to select or unselect skills to reflect your actual expertise\.)/gi;
	function hasJobDescriptionText(value) {
		const body = String(value ?? "").split(/\r?\n/)
			.map((line) => line.trim()).filter((line) => line && !descriptionChrome.test(line)).join(" ")
			.replace(jobrightGuidance, " ")
			.replace(/\b(represents the skills you have|responsibilities|qualifications?|requirements?|required|preferred)\b/gi, " ").trim();
		return body.length >= 60 && body.split(/\s+/).length >= 8 && !/^(sign in|log in|please sign in|enable javascript)/i.test(body);
	}
	function jobrightTitleDetails(title, currentRole = "") {
		const match = String(title ?? "").match(/^(.+?)\s+@\s+(.+?)\s*\|\s*Jobright(?:\.ai)?\s*$/i);
		if (!match) return null;
		const role = match[1].trim();
		const normalize = (value) => value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
		// SPA metadata can lag behind navigation. Never borrow a different job's company.
		if (currentRole && normalize(role) !== normalize(currentRole)) return null;
		return { role, company: match[2].trim() };
	}

	function extractDocument(doc, options = {}) {
		const originalUrl = options.url || doc.location?.href || doc.URL;
		const site = new URL(originalUrl).hostname.replace(/^www\./, "");
		const isJobright = site === "jobright.ai" && /\/jobs\/info\//.test(new URL(originalUrl).pathname);
		const clean = (text, max = 100000) => String(text ?? "").replace(/\u0000/g, "").replace(/[ \t]+/g, " ")
			.replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
		const textOf = (node) => {
			if (!node) return "";
			const clone = node.cloneNode(true);
			for (const child of clone.querySelectorAll("script,style,noscript,svg,nav,header,footer,form,input,textarea,select,button,[hidden],[aria-hidden='true']")) child.remove();
			for (const br of clone.querySelectorAll("br")) br.replaceWith(doc.createTextNode("\n"));
			for (const block of clone.querySelectorAll("p,li,div,section,h1,h2,h3,h4,tr")) block.append(doc.createTextNode("\n"));
			return clean(clone.textContent);
		};
		const fromHtml = (value) => {
			if (typeof value !== "string") return clean(value);
			// A detached template is inert. Never attach captured HTML to the live page.
			const template = doc.createElement("template");
			template.innerHTML = value;
			return textOf(template.content);
		};
		let canonical = originalUrl;
		const declared = doc.querySelector("link[rel~='canonical']")?.getAttribute("href");
		try {
			const candidate = canonicalUrl(declared || originalUrl, originalUrl);
			// Ignore cross-origin canonical tags; adapters may supply verified cross-site identities later.
			const samePosting = !isJobright || new URL(candidate).pathname.replace(/\/$/, "") === new URL(originalUrl).pathname.replace(/\/$/, "");
			canonical = new URL(candidate).origin === new URL(originalUrl).origin && samePosting ? candidate : canonicalUrl(originalUrl, originalUrl);
		} catch { canonical = canonicalUrl(originalUrl, originalUrl); }
		const postings = [];
		const seen = new Set();
		const walk = (value, depth = 0) => {
			if (!value || typeof value !== "object" || depth > 20 || seen.has(value)) return;
			seen.add(value);
			if (Array.isArray(value)) { for (const item of value) walk(item, depth + 1); return; }
			const types = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
			if (types.some((type) => typeof type === "string" && /(^|[/#])JobPosting$/.test(type))) postings.push(value);
			for (const item of Object.values(value)) if (item && typeof item === "object") walk(item, depth + 1);
		};
		for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
			if (script.textContent.length > 1000000) continue;
			try { walk(JSON.parse(script.textContent)); } catch { /* Broken third-party JSON-LD is not fatal. */ }
		}
		const matching = postings.filter((posting) => {
			for (const value of [posting.url, posting["@id"]]) {
				try { if (typeof value === "string" && canonicalUrl(value, originalUrl) === canonical) return true; } catch { /* Invalid page data. */ }
			}
			return false;
		});
		// Never choose the first job from a multi-job listing without matching the current URL.
		let job = matching.length === 1 ? matching[0] : postings.length === 1 ? postings[0] : null;
		if (isJobright && job) {
			const headingRole = clean(doc.querySelector("h1")?.textContent);
			if (headingRole && job.title && clean(job.title).normalize("NFKC").toLowerCase() !== headingRole.normalize("NFKC").toLowerCase()) job = null;
			try {
				const source = new URL(job?.url || job?.["@id"] || originalUrl, originalUrl);
				if (source.origin === new URL(originalUrl).origin && /\/jobs\/info\//.test(source.pathname)
					&& source.pathname.replace(/\/$/, "") !== new URL(originalUrl).pathname.replace(/\/$/, "")) job = null;
			} catch { /* Ignore malformed metadata URLs; visible sections remain available. */ }
		}
		let company = "";
		let role = "";
		let location = "";
		let description = "";
		let requirements = [];
		let extraction = "text";
		let descriptionIncomplete = false;
		let emptyJobrightSections = false;
		const warnings = [];
		if (job) {
			company = clean(job.hiringOrganization?.name, 200);
			role = clean(job.title, 300);
			description = fromHtml(job.description);
			const locations = Array.isArray(job.jobLocation) ? job.jobLocation : [job.jobLocation];
			location = clean(locations.map((item) => {
				const address = item?.address;
				return typeof address === "string" ? address : [address?.addressLocality, address?.addressRegion, address?.addressCountry?.name || address?.addressCountry].filter((value) => typeof value === "string").join(", ");
			}).filter(Boolean).join("; "), 300);
			if (!location && job.jobLocationType === "TELECOMMUTE") location = "Remote";
			requirements = [job.qualifications, job.skills, job.experienceRequirements, job.educationRequirements]
				.flatMap((item) => Array.isArray(item) ? item : [item])
				.map((item) => typeof item === "string" ? fromHtml(item) : clean(item?.description || item?.name || ""))
				.filter(Boolean).slice(0, 50).map((item) => item.slice(0, 1000));
			extraction = "jsonld";
		} else if (postings.length > 1) warnings.push("Several jobs were found; capture the individual posting or select its description.");
		if (isJobright && !hasJobDescriptionText(description)) {
			const postingId = new URL(originalUrl).pathname.split("/").filter(Boolean).at(-1);
			const candidates = [];
			const visited = new Set();
			const inspect = (value, depth = 0) => {
				if (!value || typeof value !== "object" || depth > 20 || visited.has(value)) return;
				visited.add(value);
				if (Array.isArray(value)) { for (const item of value) inspect(item, depth + 1); return; }
				if (typeof value.jobDescription === "string" && typeof (value.jobTitle || value.title) === "string") candidates.push(value);
				for (const child of Object.values(value)) if (child && typeof child === "object") inspect(child, depth + 1);
			};
			for (const script of doc.querySelectorAll('script#__NEXT_DATA__,script[type="application/json"]')) {
				if (script.textContent.length > 1000000) continue;
				try { inspect(JSON.parse(script.textContent)); } catch { /* Flight JavaScript and malformed data are never evaluated. */ }
			}
			const matched = candidates.filter((candidate) => String(candidate.jobId || candidate.id || "") === postingId);
			const candidate = matched.length === 1 ? matched[0] : candidates.length === 1 && !candidates[0].jobId && !candidates[0].id ? candidates[0] : null;
			if (candidate) {
				company = clean(candidate.companyName || candidate.company?.name || (typeof candidate.company === "string" ? candidate.company : ""), 200);
				role = clean(candidate.jobTitle || candidate.title, 300);
				description = fromHtml(candidate.jobDescription);
				location = clean(typeof candidate.location === "string" ? candidate.location : candidate.location?.name, 300);
				extraction = "adapter";
			}
		}
		if (isJobright) {
			const currentRole = clean(doc.querySelector("h1")?.textContent, 300);
			role ||= currentRole;
			const companyNode = doc.querySelector('[data-testid="company-name"], [itemprop="hiringOrganization"], [itemprop="name"][data-company]');
			company ||= clean(companyNode?.getAttribute("content") || companyNode?.textContent, 200);
			const titles = [doc.title, doc.querySelector('meta[property="og:title"]')?.getAttribute("content")];
			for (const title of titles) {
				const details = jobrightTitleDetails(title, currentRole);
				if (!details) continue;
				company ||= clean(details.company, 200);
				role ||= clean(details.role, 300);
			}
			if (!company) {
				for (const heading of doc.querySelectorAll("h2,h3")) {
					const match = clean(heading.textContent).match(/^(.+?)\s*[·•]\s*(?:\d+\s+(?:minute|hour|day|week|month|year)s?\s+ago|just now|today|yesterday)$/i);
					if (match) { company = clean(match[1], 200); break; }
				}
			}
			if (!hasJobDescriptionText(description)) {
				// Read text in document order: real Jobright headings and their bullet lists
				// can sit in separate nested wrappers, not nextElementSibling containers.
				const sections = new Map();
				let current = null;
				let visitedNodes = 0;
				let skillsUiStart = null;
				let skillsGuidanceSeen = false;
				const walkSection = (node) => {
					if (!node || ++visitedNodes > 50000) return;
					if (node.nodeType === 3) {
						const text = clean(node.textContent);
						if (current && text && !descriptionChrome.test(text)) sections.get(current).push(`${text} `);
						return;
					}
					if (/^(SCRIPT|STYLE|NOSCRIPT|SVG|NAV|FOOTER|FORM|INPUT|TEXTAREA|SELECT|BUTTON)$/.test(node.tagName)
						|| node.getAttribute?.("hidden") !== null && node.getAttribute?.("hidden") !== undefined
						|| node.getAttribute?.("aria-hidden") === "true") return;
					const label = clean(node.textContent).replace(/\s+/g, " ").replace(/:$/, "");
					if (current === "Qualification") {
						if (/^(represents the )?skills you have$/i.test(label)) {
							skillsUiStart ??= sections.get(current).length;
							return;
						}
						// Read complete elements so inline <strong> / <span> wrappers cannot leak fragments.
						if (label && label.replace(jobrightGuidance, "").trim() === "") {
							skillsUiStart ??= sections.get(current).length;
							skillsGuidanceSeen = true;
							return;
						}
						if (/^(required|preferred)$/i.test(label)) {
							// Drop personalized chips only with known UI guidance and an explicit requirements boundary.
							if (skillsGuidanceSeen && skillsUiStart !== null) sections.get(current).splice(skillsUiStart);
							skillsUiStart = null;
							skillsGuidanceSeen = false;
							sections.get(current).push(`\n${label}\n`);
							return;
						}
					}
					const heading = /^H[1-6]$/.test(node.tagName) || node.getAttribute?.("role") === "heading";
					if (heading) {
						skillsUiStart = null;
						skillsGuidanceSeen = false;
						if (sectionTitle.test(label)) {
							current = /^responsibilities$/i.test(label) ? "Responsibilities"
								: /qualification|requirement/i.test(label) ? "Qualification" : "Job description";
							if (!sections.has(current)) sections.set(current, []);
						} else if (/^(required|preferred)$/i.test(label) && current) {
							sections.get(current).push(`\n${label}\n`);
						} else if (/^H[1-3]$/.test(node.tagName) || /^(benefits|company|h1b sponsorship|similar jobs)$/i.test(label)) current = null;
						return;
					}
					for (const child of node.childNodes || []) walkSection(child);
					if (current && /^(P|LI|DIV|SECTION|BR)$/.test(node.tagName)) sections.get(current).push("\n");
				};
				walkSection(doc.querySelector("main,article") || doc.body);
				if (sections.size) {
					const blocks = [...sections].map(([label, fragments]) => ({ label, text: clean(fragments.join("")) }));
					descriptionIncomplete = visitedNodes > 50000 || blocks.some(({ text }) => !hasJobDescriptionText(text));
					emptyJobrightSections = blocks.every(({ text }) => !hasJobDescriptionText(text));
					const candidate = blocks.map(({ label, text }) => `${label}\n${text}`).join("\n\n");
					if (hasJobDescriptionText(candidate)) { description = candidate; extraction = "adapter"; }
				}
			}
		}
		if (!hasJobDescriptionText(description)) {
			let selection = "";
			try { selection = clean(options.selection ?? doc.defaultView?.getSelection()?.toString()); } catch { /* Detached fixture. */ }
			description = selection || (emptyJobrightSections ? "" : textOf(doc.querySelector("main,article") || doc.body));
			if (isJobright) {
				descriptionIncomplete = !hasJobDescriptionText(selection);
				if (!hasJobDescriptionText(description)) description = "";
			}
			extraction = "text";
			warnings.push(selection ? "Captured selected text; review company and role." : "Generic page text captured; review the description before tailoring.");
		}
		if (isJobright) description = clean(description.replace(jobrightGuidance, ""));
		const companyFallback = !company;
		const roleFallback = !role;
		company ||= site;
		role ||= clean(doc.querySelector("h1")?.textContent || doc.title || options.title || "Job posting", 300);
		if (companyFallback || roleFallback) warnings.push("Company or role needs review because a fallback was used.");
		if (!hasJobDescriptionText(description) || descriptionIncomplete) {
			warnings.push("The full job description could not be confirmed. The job will be saved for review.");
		}
		return {
			url: originalUrl, canonicalUrl: canonical, title: clean(doc.title || options.title, 500), company, role, location,
			description, requirements, extraction, capturedAt: new Date().toISOString(),
			companyFallback, roleFallback, descriptionIncomplete, warnings,
		};
	}
	globalThis.ReactiveCaptureExtract = { canonicalUrl, extractDocument, hasJobDescriptionText, jobrightTitleDetails };
})();
