/* Runs only after the user opens the extension. No network, storage, or submission. */
(() => {
	const MAX_RESUME_BYTES = 10 * 1024 * 1024;
	const CONTROL_SELECTOR = 'input, textarea, select, [role="combobox"], [aria-haspopup="listbox"]';
	const normalize = value => String(value ?? "").normalize("NFKC").toLocaleLowerCase("en-US")
		.replace(/[’']/g, "").replace(/[\s\p{P}\p{S}]+/gu, " ").trim();
	const questionKey = value => normalize(String(value ?? "").replace(/\s*\*\s*$/, ""));
	const text = element => String(element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim();
	const hash = value => {
		let result = 2166136261;
		for (const character of value) result = Math.imul(result ^ character.charCodeAt(0), 16777619);
		return (result >>> 0).toString(36);
	};
	const strings = value => typeof value === "string" || typeof value === "number" || typeof value === "boolean"
		? String(value).trim() : "";
	const safeUrl = value => {
		try { return /^https?:$/.test(new URL(value).protocol) ? value : ""; } catch { return ""; }
	};
	const isConsent = value => /\b(consent|agree|agreement|terms|privacy|marketing|subscribe|communications?|background check|certify|certification|attest|signature|acknowledge)\b/.test(value);
	const isSensitive = value => /\b(gender|sex|race|racial|ethnicity|ethnic|veteran|disability|disabled|birth|age|ssn|social security|religion|sexual|pronouns?)\b/.test(value);
	const isScreening = value => /\b(authorized|authorization|sponsorship|citizen|citizenship|visa|eligible|eligibility|salary|compensation|willing|relocat|years|experience|degree|education|graduate|gpa|availability|start date|notice period|criminal|convict|legal|worked|employment|employer|school|university|college|company|referr|hear about)\b/.test(value);
	const nonCandidateContext = value => /\b(employment|employer|company|work history|education|school|university|college|institution|references?|referee|ref|emergency|supervisor|recommender)\b/.test(value);
	const words = value => normalize(String(value || "").replace(/([a-z])([A-Z])/g, "$1 $2"));
	function otherPartyField(field) {
		if (nonCandidateContext(words(field.context))) return true;
		const identifiers = words(`${field.name} ${field.element.id}`), label = words(field.label);
		const specificParty = /\b(employment|employer|education|school|university|college|institution|references?|referee|ref|emergency|supervisor|recommender)\b/;
		if (specificParty.test(identifiers) || specificParty.test(label)) return true;
		// "Why this company?" is an application question, not an employer contact field.
		return /^(?:(?:current|previous|past|former) )?(?:company|organization)(?: (?:name|email|phone|address|city|state|country|website))?$/.test(label)
			|| /\bcompany (?:name|email|phone|address|city|state|country|website)\b/.test(identifiers);
	}
	const combobox = element => element.tagName !== "SELECT" && (element.getAttribute("role") === "combobox" || element.getAttribute("aria-haspopup") === "listbox");

	function labelText(element, excludedIds = new Set()) {
		if (!element?.childNodes) return text(element);
		function visit(node) {
			if (node.nodeType === 3) return node.nodeValue || "";
			if (node !== element && (excludedIds.has(node.id) || node.hidden || node.getAttribute?.("aria-hidden") === "true"
				|| /^(INPUT|SELECT|TEXTAREA|OPTION|BUTTON|SCRIPT|STYLE|NOSCRIPT)$/.test(node.tagName || "")
				|| /^(combobox|listbox|option|tooltip|alert|status)$/.test(node.getAttribute?.("role") || ""))) return "";
			return [...(node.childNodes || [])].map(visit).join(" ");
		}
		return visit(element).replace(/\s+/g, " ").trim();
	}

	function getById(root, id) {
		if (root.getElementById) return root.getElementById(id);
		return [...root.querySelectorAll("[id]")].find(element => element.id === id) || null;
	}
	function labelFor(element) {
		const root = element.getRootNode();
		const helpIds = new Set((element.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean));
		const labelled = (element.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)
			.map(id => labelText(getById(root, id), helpIds)).filter(Boolean).join(" ");
		if (labelled) return labelled;
		const aria = element.getAttribute("aria-label");
		if (aria?.trim()) return aria.trim();
		const labels = [...(element.labels || [])].map(label => labelText(label, helpIds).slice(0, 1500)).filter(Boolean);
		if (labels.length) return labels.join(" ");
		const wrapping = element.closest("label");
		if (wrapping) return labelText(wrapping, helpIds).slice(0, 1500);
		return element.getAttribute("placeholder") || element.getAttribute("title") || element.name || element.id || "Unlabelled field";
	}
	function groupLabel(element) {
		const fieldset = element.closest("fieldset");
		const legend = fieldset?.querySelector("legend");
		if (legend) return labelText(legend).slice(0, 1500);
		const group = element.closest('[role="radiogroup"], [role="group"]');
		if (group) {
			const label = group.getAttribute("aria-label");
			if (label) return label;
			const ids = (group.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
			const result = ids.map(id => labelText(getById(element.getRootNode(), id))).filter(Boolean).join(" ");
			if (result) return result;
		}
		return "";
	}
	function contextFor(element) {
		let ancestor = element.parentElement;
		for (let depth = 0; ancestor && depth < 4; depth++, ancestor = ancestor.parentElement) {
			const heading = ancestor.querySelector(":scope > legend, :scope > h2, :scope > h3, :scope > h4");
			if (heading) return text(heading);
		}
		return "";
	}
	function visible(element) {
		if (element.hidden || element.getAttribute("aria-hidden") === "true" || element.closest("[hidden], [inert]")) return false;
		// Real file inputs are often visually hidden behind a labelled upload button.
		if (element.type === "file") return true;
		const view = element.ownerDocument.defaultView;
		if (view?.getComputedStyle) {
			const style = view.getComputedStyle(element);
			if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
			if (element.getClientRects && element.getClientRects().length === 0) return false;
		}
		return true;
	}
	function identity(element) {
		const parts = [];
		let current = element;
		while (current) {
			if (current.nodeType !== 1) { current = current.host; continue; }
			const parent = current.parentElement;
			const siblings = parent ? [...parent.children].filter(item => item.tagName === current.tagName) : [current];
			parts.push(`${current.tagName}:${current.id || ""}:${current.getAttribute("name") || ""}:${siblings.indexOf(current)}`);
			current = parent || current.getRootNode()?.host;
		}
		return parts.reverse().join("/");
	}
	function controlOptions(element, type, elements) {
		return type === "radio" ? elements.map(item => ({ label: labelFor(item), value: item.value }))
			: element.tagName === "SELECT" ? [...element.options].filter(option => !option.disabled)
				.map(option => ({ label: option.label || text(option), value: option.value })) : [];
	}
	function controlValue(element, type, elements) {
		const comboText = type === "combobox" && element.tagName !== "INPUT" ? text(element) : "";
		const comboValue = comboText && !/^(?:select|choose|please select|please choose)(?:\b|$)/i.test(comboText) ? comboText : "";
		return type === "radio" ? elements.find(item => item.checked)?.value || ""
			: type === "checkbox" ? element.checked ? "checked" : ""
				: type === "file" ? [...(element.files || [])].map(file => file.name).join(", ") : element.value || comboValue;
	}
	function collect(document) {
		const controls = [];
		function visit(root) {
			for (const element of root.querySelectorAll(CONTROL_SELECTOR)) {
				const type = String(element.type || element.getAttribute("role") || element.tagName).toLowerCase();
				if (["hidden", "password", "submit", "reset", "button", "image"].includes(type)
					&& !combobox(element)) continue;
				if (element.disabled || element.readOnly || element.getAttribute("aria-disabled") === "true" || !visible(element)) continue;
				controls.push(element);
			}
			for (const element of root.querySelectorAll("*")) if (element.shadowRoot) visit(element.shadowRoot);
		}
		visit(document);
		const seenRadioGroups = new Set();
		return controls.flatMap(element => {
			const type = element.type === "radio" ? "radio" : combobox(element) ? "combobox"
				: String(element.type || element.tagName).toLowerCase();
			let elements = [element];
			if (type === "radio" && element.name) {
				const root = element.getRootNode();
				const groupIdentity = `${identity(element.form || root.host || root.documentElement || element.parentElement)}:${element.name}`;
				if (seenRadioGroups.has(groupIdentity)) return [];
				seenRadioGroups.add(groupIdentity);
				elements = controls.filter(item => item.type === "radio" && item.name === element.name
					&& item.form === element.form && item.getRootNode() === root);
			}
			const label = (type === "radio" ? groupLabel(element) : "") || labelFor(element);
			const id = `rr-${hash(`${identity(element)}|${type}|${label}`)}`;
			const options = controlOptions(element, type, elements);
			const currentValue = controlValue(element, type, elements);
			return [{ id, label, type, options, currentValue, required: Boolean(element.required || element.getAttribute("aria-required") === "true"),
				name: element.name || "", autocomplete: element.getAttribute("autocomplete") || "", context: contextFor(element), element, elements }];
		});
	}
	function publicField(field) {
		const { element: _element, elements: _elements, context: _context, ...result } = field;
		return result;
	}
	function approvedAnswer(field, packet, questionCounts) {
		const key = questionKey(field.label);
		const candidates = (Array.isArray(packet.answers) ? packet.answers : []).filter(answer => answer?.approved !== false
			&& questionKey(answer.question) === key
			&& (!answer.fieldId || answer.fieldId === field.id)
			&& (!answer.applicationId || answer.applicationId === packet.application?.id));
		if (candidates.length && questionCounts.get(key) > 1 && !candidates.some(answer => answer.fieldId === field.id)) return { ambiguous: true };
		if (otherPartyField(field) && !candidates.some(answer => answer.fieldId === field.id)) return { needsFieldScope: true };
		const fieldScoped = candidates.filter(answer => answer.fieldId === field.id);
		const applicable = fieldScoped.length ? fieldScoped : candidates;
		const scoped = applicable.filter(answer => answer.applicationId && answer.applicationId === packet.application?.id);
		const matches = scoped.length ? scoped : applicable;
		const values = [...new Set(matches.map(answer => strings(answer.answer)).filter(Boolean))];
		if (values.length > 1) return { conflict: true };
		return values.length === 1 ? { value: values[0], source: scoped.length ? "approved job answer" : "approved answer" } : null;
	}
	function profileValue(field, profile) {
		const label = questionKey(field.label);
		const name = normalize(field.name.replace(/([a-z])([A-Z])/g, "$1 $2"));
		const combined = `${label} ${name}`;
		if (otherPartyField(field) || isConsent(combined) || isSensitive(combined) || isScreening(combined)) return null;
		const auto = field.autocomplete.trim().split(/\s+/).at(-1);
		const autoKeys = { "given-name": "firstName", "family-name": "lastName", name: "fullName", email: "email", tel: "phone",
			"address-line1": "address", "address-line2": "address2", "address-level2": "city", "address-level1": "state", "postal-code": "postalCode", country: "country", "country-name": "country" };
		let key = autoKeys[auto];
		if (!key) {
			const rules = [
				["firstName", /^(?:(?:your|candidate|applicant) )?(?:first|given) name$/],
				["lastName", /^(?:(?:your|candidate|applicant) )?(?:last|family|sur) ?name$/],
				["fullName", /^(?:(?:your|candidate|applicant|full|preferred) )?name$/],
				["email", /^(?:your |contact |primary )?e ?mail(?: address)?$/],
				["phone", /^(?:your |contact |mobile |cell |primary )?(?:phone|telephone|mobile)(?: number)?$/],
				["city", /^(?:current |home )?city(?: town)?$/],
				["state", /^(?:current |home )?(?:state|province|state province|region)$/],
				["country", /^(?:current |home )?country(?: of residence)?$/],
				["postalCode", /^(?:zip|postal|zip postal)(?: code)?$/],
				["address", /^(?:street |home |mailing )?address(?: line 1)?$/],
				["address2", /^address line 2$/],
				["linkedin", /^(?:your )?linked ?in(?: profile| url| link| profile url)?$/],
				["github", /^(?:your )?github(?: profile| url| link| profile url)?$/],
				["website", /^(?:your |personal |portfolio )?(?:website|portfolio)(?: url| link)?$/],
				["location", /^(?:current |home )?location$/],
			];
			key = rules.find(([, expression]) => expression.test(label))?.[0];
			if (!key && label === name) key = rules.find(([, expression]) => expression.test(name))?.[0];
		}
		if (!key) return null;
		let value = strings(profile[key]);
		if (!value && key === "fullName") value = [strings(profile.firstName), strings(profile.lastName)].filter(Boolean).join(" ");
		if (!value && key === "location") value = [profile.city, profile.state, profile.country].map(strings).filter(Boolean).join(", ");
		if (["linkedin", "github", "website"].includes(key)) value = safeUrl(value);
		return value ? { value, source: `profile.${key}` } : null;
	}
	function normalizedOption(value) {
		const result = normalize(value);
		return ({ us: "united states", usa: "united states", "united states of america": "united states", uk: "united kingdom", gb: "united kingdom" })[result] || result;
	}
	function optionIndex(options, desired) {
		const target = normalizedOption(desired);
		const matches = options.map((option, index) => ({ option, index })).filter(({ option }) => !placeholderOption(option)
			&& (normalizedOption(option.label) === target || normalizedOption(option.value) === target));
		return matches.length === 1 ? matches[0].index : -1;
	}
	function placeholderOption(option) {
		if (!option) return false;
		const label = normalize(option.label || text(option));
		return option.value === "" || /^(?:please )?(?:select|choose)(?:\b|$)/.test(label);
	}
	function classify(field, packet, questionCounts) {
		const result = { ...publicField(field), matched: false, status: "unmatched", reason: "No exact approved answer or supported profile field." };
		if (field.currentValue && !(field.element.tagName === "SELECT" && placeholderOption(field.element.selectedOptions?.[0]))) {
			return { ...result, status: "preserved", reason: "Existing value kept. Clear it on the page if you want to replace it." };
		}
		const answer = approvedAnswer(field, packet, questionCounts);
		if (answer?.needsFieldScope) return { ...result, reason: "This field is about another person or organization. Fill it manually or approve this exact field." };
		if (answer?.ambiguous) return { ...result, reason: "This question repeats in multiple fields. Approve a specific field or fill it manually." };
		if (answer?.conflict) return { ...result, reason: "Conflicting approved answers. Resolve them before filling." };
		const terms = normalize(`${field.label} ${field.name}`);
		if (field.type === "file") {
			if (otherPartyField(field)) return { ...result, status: "unsupported", reason: "This upload belongs to another person or organization. Attach their document manually." };
			if (!/\b(resume|cv|curriculum vitae)\b/.test(terms) || /\bcover\b/.test(terms)) return { ...result, status: "unsupported", reason: "This upload is not clearly a resume field." };
			if (!packet.resume?.base64) return { ...result, reason: "Select this application's PDF first." };
			const accept = String(field.element.accept || "").toLowerCase();
			if (accept && !accept.split(",").some(value => [".pdf", "application/pdf", "application/*", "*/*"].includes(value.trim()))) {
				return { ...result, status: "unsupported", reason: "This upload does not accept PDF files." };
			}
			return { ...result, status: "matched", matched: true, value: String(packet.resume.fileName || "resume.pdf"), source: "selected application PDF", reason: "File selection will be verified; the website's upload must still finish." };
		}
		if ((isConsent(terms) || isSensitive(terms) || isScreening(terms)) && !answer) {
			return { ...result, reason: "This question needs your exact approved answer." };
		}
		const value = answer || profileValue(field, packet.profile || {});
		if (!value) return result;
		if (field.type === "combobox" && ((field.element.tagName === "BUTTON" && field.element.type !== "button")
			|| ["submit", "image", "reset"].includes(field.element.type))) return { ...result, status: "unsupported", reason: "This dropdown can submit the form; select it manually." };
		if (field.type === "radio" || field.element.tagName === "SELECT") {
			if (optionIndex(field.options, value.value) < 0) return { ...result, status: "unsupported", reason: "No unique option exactly matches the approved value.", value: value.value, source: value.source };
		}
		if (field.type === "checkbox" && !/^(yes|no|true|false|checked|unchecked)$/i.test(value.value)) return { ...result, status: "unsupported", reason: "Approve an explicit Yes or No for this checkbox." };
		return { ...result, ...value, status: "matched", matched: true, reason: "" };
	}
	function fingerprint(fields, document) {
		const pageIdentity = [document.title || "", ...[...document.querySelectorAll("h1")].slice(0, 10).map(text),
			...[...(document.forms || [])].slice(0, 20).map(form => `${form.action}|${form.method}`)].join("\n");
		return hash(`${pageIdentity}\n${fields.map(field => `${field.id}|${field.label}|${field.type}|${JSON.stringify(field.options)}`).join("\n")}`);
	}
	function countQuestions(fields) {
		const counts = new Map();
		for (const field of fields) { const key = questionKey(field.label); counts.set(key, (counts.get(key) || 0) + 1); }
		return counts;
	}
	function plan(document, packet = {}) {
		const controls = collect(document), questionCounts = countQuestions(controls);
		const fields = controls.map(field => classify(field, packet, questionCounts));
		return { pageUrl: document.URL, fingerprint: fingerprint(fields, document), fields,
			matched: fields.filter(field => field.matched), unmatched: fields.filter(field => !field.matched),
			counts: { total: fields.length, matched: fields.filter(field => field.matched).length,
				preserved: fields.filter(field => field.status === "preserved").length, unmatched: fields.filter(field => field.status === "unmatched").length,
				unsupported: fields.filter(field => field.status === "unsupported").length } };
	}
	function setNative(element, property, value) {
		let prototype = Object.getPrototypeOf(element);
		while (prototype) {
			const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
			if (descriptor?.set) { descriptor.set.call(element, value); return; }
			prototype = Object.getPrototypeOf(prototype);
		}
		throw new Error("This control has no supported native setter.");
	}
	function events(element, input = true) {
		const view = element.ownerDocument.defaultView;
		if (input) element.dispatchEvent(new view.InputEvent("input", { bubbles: true, composed: true, inputType: "insertText" }));
		element.dispatchEvent(new view.Event("change", { bubbles: true, composed: true }));
		element.dispatchEvent(new view.FocusEvent("blur", { bubbles: true, composed: true }));
		element.dispatchEvent(new view.FocusEvent("focusout", { bubbles: true, composed: true }));
	}
	function resumeFile(document, resume) {
		if (resume.mimeType && resume.mimeType !== "application/pdf") throw new Error("The selected resume must be a PDF.");
		if (typeof resume.base64 !== "string" || resume.base64.length > Math.ceil(MAX_RESUME_BYTES / 3) * 4 + 4) throw new Error("The selected PDF exceeds 10 MB.");
		let binary;
		try { binary = document.defaultView.atob(resume.base64); } catch { throw new Error("The selected PDF could not be decoded."); }
		if (!binary.startsWith("%PDF-") || binary.length > MAX_RESUME_BYTES) throw new Error("The selected file is not a valid PDF within the 10 MB limit.");
		const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
		const filename = String(resume.fileName || "resume.pdf").replace(/[\\/\u0000-\u001f]/g, "_");
		return new document.defaultView.File([bytes], filename.endsWith(".pdf") ? filename : `${filename}.pdf`, { type: "application/pdf" });
	}
	async function setChecked(element, checked) {
		// React's checkbox/radio change plugin observes the native click pathway.
		// Setting checked before clicking would toggle it back, so click only when needed.
		if (element.checked !== checked) element.click();
		await new Promise(resolve => setTimeout(resolve, 0));
		const current = element.isConnected ? element : getById(element.getRootNode(), element.id);
		if (!current || current.checked !== checked) throw new Error("The site did not retain this choice.");
	}
	async function fillCombobox(field, desired) {
		const element = field.element;
		if ((element.tagName === "BUTTON" && element.type !== "button") || ["submit", "image", "reset"].includes(element.type)) throw new Error("This dropdown can submit the form; select it manually.");
		const original = element.value;
		const view = element.ownerDocument.defaultView;
		const existingOptions = new Set([...element.getRootNode().querySelectorAll('[role="option"]')].filter(visible));
		element.click();
		if (element.tagName === "INPUT") { setNative(element, "value", desired); events(element); }
		let selected = null;
		for (let attempt = 0; attempt < 8; attempt++) {
			const root = element.getRootNode();
			const controlled = (element.getAttribute("aria-controls") || element.getAttribute("aria-owns") || "").split(/\s+/).filter(Boolean)
				.map(id => getById(root, id) || element.ownerDocument.getElementById(id)).filter(Boolean);
			const areas = controlled.length ? controlled : [root];
			const options = [...new Set(areas.flatMap(area => [...area.querySelectorAll('[role="option"]')]))]
				.filter(option => visible(option) && option.getAttribute("aria-disabled") !== "true"
					&& (controlled.length || !existingOptions.has(option)));
			const matches = options.filter(option => normalizedOption(text(option)) === normalizedOption(desired));
			if (matches.length === 1) { selected = matches[0]; break; }
			if (matches.length > 1) break;
			await new Promise(resolve => setTimeout(resolve, 50));
		}
		if (!selected) {
			if (element.tagName === "INPUT") { setNative(element, "value", original || ""); events(element); }
			element.dispatchEvent(new view.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
			throw new Error("No unique visible dropdown option matched. Select this control manually.");
		}
		if ((selected.tagName === "BUTTON" && selected.type !== "button") || selected.type === "submit") {
			if (element.tagName === "INPUT") { setNative(element, "value", original || ""); events(element); }
			throw new Error("This dropdown option can submit the form; select it manually.");
		}
		selected.click();
		await new Promise(resolve => setTimeout(resolve, 0));
		return "A matching option was selected. Check that the site retained it.";
	}
	async function fill(document, packet = {}, options = {}) {
		const originalPlan = plan(document, packet);
		if (options.expectedUrl && options.expectedUrl !== document.URL) throw new Error("The application page changed. Scan it again before filling.");
		if (options.expectedFingerprint && options.expectedFingerprint !== originalPlan.fingerprint) throw new Error("The application fields changed. Scan them again before filling.");
		const selectedIds = options.fieldIds ?? packet.selectedFieldIds;
		const chosen = Array.isArray(selectedIds) ? new Set(selectedIds) : null;
		const result = { pageUrl: document.URL, filled: [], skipped: [], failed: [], unmatched: [], unsupported: [], counts: {} };
		let pdf;
		const controls = collect(document), questionCounts = countQuestions(controls);
		for (const snapshot of controls) {
			const field = { ...snapshot, currentValue: controlValue(snapshot.element, snapshot.type, snapshot.elements),
				options: controlOptions(snapshot.element, snapshot.type, snapshot.elements) };
			const entry = classify(field, packet, questionCounts);
			if (!entry.matched || (chosen && !chosen.has(field.id))) {
				const skipped = chosen && !chosen.has(field.id) && entry.matched ? { ...entry, reason: "Not selected in the preview." } : entry;
				result.skipped.push(skipped);
				if (entry.status === "unsupported") result.unsupported.push(entry);
				if (entry.status === "unmatched") result.unmatched.push(entry);
				continue;
			}
			// Recheck connected/current state immediately before each write; prior controls can re-render the form.
			if (!field.element.isConnected || document.URL !== originalPlan.pageUrl) {
				result.failed.push({ ...entry, reason: "The page changed while filling. Scan this step again." }); continue;
			}
			if (field.element.disabled || field.element.readOnly || !visible(field.element)
				|| ((field.type === "radio" ? groupLabel(field.element) : "") || labelFor(field.element)) !== field.label) {
				result.failed.push({ ...entry, reason: "This field changed while filling. Scan this step again." }); continue;
			}
			try {
				let note = "";
				if (field.type === "file") {
					pdf ||= resumeFile(document, packet.resume);
					const transfer = new document.defaultView.DataTransfer(); transfer.items.add(pdf);
					setNative(field.element, "files", transfer.files); events(field.element, false);
					if (field.element.files?.[0]?.name !== pdf.name || field.element.files[0].size !== pdf.size) throw new Error("The website did not retain the selected file.");
					note = "PDF selected. Verify the website finishes uploading it before submitting.";
				} else if (field.type === "combobox") note = await fillCombobox(field, entry.value);
				else if (field.type === "radio") {
					const index = optionIndex(field.options, entry.value);
					await setChecked(field.elements[index], true);
				} else if (field.type === "checkbox") {
					const checked = /^(yes|true|checked)$/i.test(entry.value);
					await setChecked(field.element, checked);
				} else {
					const value = field.element.tagName === "SELECT" ? field.options[optionIndex(field.options, entry.value)].value : entry.value;
					setNative(field.element, "value", value); events(field.element);
					if (field.element.value !== value) throw new Error("The site did not retain the value. Check its format and validation.");
				}
				result.filled.push({ ...entry, ...(note ? { note } : {}) });
			} catch (error) {
				const failed = { ...entry, reason: error.message };
				result.failed.push(failed);
				if (field.type === "combobox") result.unsupported.push(failed);
			}
		}
		for (const key of ["filled", "skipped", "failed", "unmatched", "unsupported"]) result.counts[key] = result[key].length;
		result.counts.total = originalPlan.fields.length;
		return result;
	}
	globalThis.ReactiveResumeAutofill = Object.freeze({ scan: document => collect(document).map(publicField), plan, fill });
})();
