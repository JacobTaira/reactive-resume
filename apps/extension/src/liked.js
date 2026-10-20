/* global chrome */
(() => {
	if (globalThis.reactiveCaptureLikedInstalled) return;
	globalThis.reactiveCaptureLikedInstalled = true;
	let running = false;
	let localCancel = false;
	let panel;
	const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
	const send = async (message) => {
		const response = await chrome.runtime.sendMessage(message);
		if (!response?.ok) throw new Error(response?.error || "The extension is unavailable. Reload this page.");
		return response.data;
	};
	const current = async () => (await send({ type: "bulk-get" })).bulk;
	const save = (bulk, resume = false) => send({ type: "bulk-state", resume, bulk: { ...bulk, updatedAt: new Date().toISOString() } });
	const status = (message) => { if (panel) panel.querySelector("[data-status]").textContent = message; };
	const isLiked = () => location.origin === "https://jobright.ai" && /^\/jobs\/liked\/?$/.test(location.pathname);
	const links = () => {
		const items = [];
		for (const anchor of document.querySelectorAll('a[href*="/jobs/info/"]')) {
			try {
				const url = new URL(anchor.getAttribute("href"), location.href);
				if (url.origin !== location.origin || !/^\/jobs\/info\/[^/]+\/?$/.test(url.pathname)) continue;
				url.searchParams.delete("visit");
				items.push({ url: globalThis.ReactiveCaptureExtract.canonicalUrl(url.href, location.href), title: anchor.textContent.trim().slice(0, 300), status: "pending", error: "" });
			} catch { /* Ignore malformed page links. */ }
		}
		return items;
	};
	const scrollContainer = () => {
		let node = document.querySelector('a[href*="/jobs/info/"]')?.parentElement;
		while (node && node !== document.body) {
			if (node.scrollHeight > node.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(node).overflowY)) return node;
			node = node.parentElement;
		}
		return document.scrollingElement || document.documentElement;
	};
	const stopped = async (id) => {
		if (localCancel || !isLiked()) return true;
		const stored = await current();
		return stored?.id !== id || stored.canceled;
	};
	async function run(resume) {
		if (running) return;
		running = true;
		localCancel = false;
		let bulk;
		try {
			const previous = await current();
			bulk = resume && previous ? { ...previous, canceled: false, phase: previous.collectionDone ? "capturing" : "collecting" } : {
				id: crypto.randomUUID(), startedAt: new Date().toISOString(), phase: "collecting", canceled: false,
				items: [], collectionDone: false, endVerified: false, warning: "", failures: [],
			};
			await save(bulk, true);
			if (!bulk.collectionDone) {
				let stable = 0;
				for (let pass = 0; pass < 150; pass++) {
					if (await stopped(bulk.id)) break;
					const known = new Map(bulk.items.map((item) => [item.url, item]));
					const count = known.size;
					for (const item of links()) if (!known.has(item.url) && known.size < 5000) known.set(item.url, item);
					bulk.items = [...known.values()];
					if (bulk.items.length >= 5000) { bulk.warning = "Stopped at the 5,000-job discovery limit. More liked jobs may remain."; break; }
					stable = bulk.items.length === count ? stable + 1 : 0;
					status(`Found ${bulk.items.length} distinct jobs. Loading the liked list…`);
					await save(bulk);
					const text = document.querySelector("main")?.innerText || "";
					if (/you(?:'ve| have) reached the end|no more (liked )?jobs|all liked jobs (?:are )?loaded/i.test(text)) { bulk.endVerified = true; break; }
					if (stable >= 8) break;
					const container = scrollContainer();
					const more = [...container.querySelectorAll("button")].find((button) => /^(load more|load more jobs|show more jobs)$/i.test(button.textContent.trim()) && !button.disabled && button.getClientRects().length);
					if (more) more.click();
					else container.scrollBy({ top: Math.max(500, container.clientHeight * 0.85), behavior: "instant" });
					await sleep(1100);
				}
				if (await stopped(bulk.id)) { bulk.phase = "paused"; bulk.canceled = true; await save(bulk); status("Collection paused. Resume keeps the jobs already found."); return; }
				bulk.collectionDone = true;
				if (!bulk.endVerified) bulk.warning ||= "The end of the liked list could not be verified. Only discovered jobs are included; additional liked jobs may remain.";
				bulk.phase = "capturing";
				await save(bulk);
			}
			for (let index = 0; index < bulk.items.length; index++) {
				if (await stopped(bulk.id)) { bulk.phase = "paused"; bulk.canceled = true; break; }
				const item = bulk.items[index];
				if (item.status === "captured") continue;
				status(`Capturing ${index + 1}/${bulk.items.length}. ${bulk.warning}`);
				try {
					const response = await fetch(item.url, { credentials: "same-origin", redirect: "follow", signal: AbortSignal.timeout(20000) });
					if (!response.ok) throw new Error(`Jobright returned HTTP ${response.status}`);
					if (new URL(response.url).origin !== location.origin || /\/(login|signin|sign-in|auth)(\/|$)/i.test(new URL(response.url).pathname)) throw new Error("The posting redirected to a login page or another site.");
					const html = await response.text();
					if (html.length > 5_000_000) throw new Error("The job page exceeded the extraction limit.");
					const doc = new DOMParser().parseFromString(html, "text/html");
					const payload = globalThis.ReactiveCaptureExtract.extractDocument(doc, { url: item.url, title: item.title, selection: "" });
					const pageText = (doc.querySelector("main") || doc.body)?.textContent || "";
					if (payload.extraction === "text" || /^(sign in|log in|enable javascript|loading)[ .…!]*$/i.test(pageText.trim()) || /sign in|log in/i.test(doc.title)) {
						payload.description = "";
						payload.warnings.push("Fetched HTML did not contain a confirmed job description. Open the posting and capture its rendered page.");
					}
					const result = await send({ type: "capture", payload });
					item.status = "captured";
					item.localCaptureId = result.id;
					item.error = "";
				} catch (error) {
					// Preserve even inaccessible postings as visible needs-details applications.
					try {
						const result = await send({ type: "capture", payload: { url: item.url, canonicalUrl: item.url, title: item.title, company: "", role: item.title,
							description: "", extraction: "text", capturedAt: new Date().toISOString(), companyFallback: true, roleFallback: true, warnings: [error.message] } });
						item.status = "captured"; item.localCaptureId = result.id; item.error = `Needs details: ${error.message}`;
					} catch (saveError) { item.status = "failed"; item.error = saveError.message; }
				}
				await save(bulk);
				await sleep(1100);
			}
			bulk.phase = bulk.canceled ? "paused" : "finished";
			bulk.failures = bulk.items.filter((item) => item.error).map(({ url, error }) => ({ url, error }));
			await save(bulk);
			const captured = bulk.items.filter((item) => item.status === "captured").length;
			status(`${captured}/${bulk.items.length} discovered jobs captured locally for sync. ${bulk.failures.length} need attention. ${bulk.warning} Open extension settings for server confirmations.`);
		} catch (error) {
			status(`Capture paused: ${error.message}. Progress is retained. Open extension settings.`);
		} finally { running = false; }
	}
	function mount() {
		if (!isLiked()) { panel?.remove(); panel = null; return; }
		if (panel?.isConnected) return;
		panel = document.createElement("section");
		panel.setAttribute("aria-label", "Reactive Resume capture queue");
		Object.assign(panel.style, { position: "fixed", bottom: "16px", right: "16px", zIndex: "2147483647", maxWidth: "360px", padding: "14px", background: "#15213b", color: "#fff", borderRadius: "10px", boxShadow: "0 4px 18px #0005", font: "14px/1.5 system-ui" });
		const heading = document.createElement("strong"); heading.textContent = "Reactive Resume"; panel.append(heading);
		const description = document.createElement("p"); description.dataset.status = ""; description.textContent = "Capture liked jobs into Applications. Keep this tab open while collecting."; panel.append(description);
		for (const [label, action] of [["Queue all", () => run(false)], ["Resume", () => run(true)], ["Pause", () => { localCancel = true; status("Pausing after the current operation…"); }]]) {
			const button = document.createElement("button"); button.textContent = label; button.type = "button";
			Object.assign(button.style, { marginRight: "8px", padding: "6px 10px", border: "1px solid #a6b9e2", borderRadius: "5px", background: "#fff", color: "#14213b", cursor: "pointer" });
			button.addEventListener("click", (event) => { if (event.isTrusted) action(); }); panel.append(button);
		}
		document.body.append(panel);
	}
	new MutationObserver(mount).observe(document.documentElement, { childList: true, subtree: true });
	window.addEventListener("popstate", mount);
	mount();
})();
