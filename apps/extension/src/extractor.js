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

	function extractDocument(doc, options = {}) {
		const originalUrl = options.url || doc.location?.href || doc.URL;
		const site = new URL(originalUrl).hostname.replace(/^www\./, "");
		const clean = (text, max = 100000) => String(text ?? "").replace(/\u0000/g, "").replace(/[ \t]+/g, " ")
			.replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
		const textOf = (node) => {
			if (!node) return "";
			const clone = node.cloneNode(true);
			for (const child of clone.querySelectorAll("script,style,noscript,nav,header,footer,form,input,textarea,select,button,[hidden],[aria-hidden='true']")) child.remove();
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
			canonical = new URL(candidate).origin === new URL(originalUrl).origin ? candidate : canonicalUrl(originalUrl, originalUrl);
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
		const job = matching.length === 1 ? matching[0] : postings.length === 1 ? postings[0] : null;
		let company = "";
		let role = "";
		let location = "";
		let description = "";
		let requirements = [];
		let extraction = "text";
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
		if (site === "jobright.ai" && /\/jobs\/info\//.test(new URL(originalUrl).pathname) && !description) {
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
		if (site === "jobright.ai" && /\/jobs\/info\//.test(new URL(originalUrl).pathname) && !description) {
			const headings = [...doc.querySelectorAll("h1,h2,h3,h4,[role='heading']")];
			const blocks = [];
			for (const heading of headings) {
				if (!/^(responsibilities|qualifications?|requirements?|preferred qualifications?|about (the )?(job|role)|job description)$/i.test(clean(heading.textContent))) continue;
				let node = heading.nextElementSibling;
				const parts = [clean(heading.textContent)];
				while (node && !/^H[1-4]$/.test(node.tagName)) { parts.push(textOf(node)); node = node.nextElementSibling; }
				if (parts.length === 1 && heading.parentElement) parts.push(textOf(heading.parentElement));
				blocks.push(parts.filter(Boolean).join("\n"));
			}
			if (blocks.length) {
				description = [...new Set(blocks)].join("\n\n");
				role ||= clean(doc.querySelector("h1")?.textContent, 300);
				company ||= clean(doc.querySelector('[data-testid="company-name"], [itemprop="hiringOrganization"]')?.textContent, 200);
				extraction = "adapter";
			}
		}
		if (!description) {
			let selection = "";
			try { selection = clean(options.selection ?? doc.defaultView?.getSelection()?.toString()); } catch { /* Detached fixture. */ }
			description = selection || textOf(doc.querySelector("main,article") || doc.body);
			warnings.push(selection ? "Captured selected text; review company and role." : "Generic page text captured; review the description before tailoring.");
		}
		const companyFallback = !company;
		const roleFallback = !role;
		company ||= site;
		role ||= clean(doc.querySelector("h1")?.textContent || doc.title || options.title || "Job posting", 300);
		if (companyFallback || roleFallback) warnings.push("Company or role needs review because a fallback was used.");
		if (!description || description.length < 80 || /^(sign in|log in|please sign in|enable javascript)/i.test(description)) {
			warnings.push("The full job description could not be confirmed. The job will be saved for review.");
		}
		return {
			url: originalUrl, canonicalUrl: canonical, title: clean(doc.title || options.title, 500), company, role, location,
			description, requirements, extraction, capturedAt: new Date().toISOString(),
			companyFallback, roleFallback, warnings,
		};
	}
	globalThis.ReactiveCaptureExtract = { canonicalUrl, extractDocument };
})();
