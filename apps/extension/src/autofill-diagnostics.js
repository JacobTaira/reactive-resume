/* Read-only form structure. Never collects entered values, files or choice state. */
(() => {
	const GROUPS = 'fieldset, [role="radiogroup"], [role="group"], .ashby-application-form-field-entry, [data-field-path][data-field-entry-id]';
	const CONTROLS = 'input, textarea, select, button, [role="combobox"], [role="radio"], [role="checkbox"], [role="option"], [aria-haspopup="listbox"]';
	const STATE_NAMES = ["aria-checked", "aria-pressed", "aria-selected", "data-state"];
	const ATTACHMENT = /\b(resume|cv|curriculum vitae|cover letter|attachment|upload|file)\b/i;
	const clean = (value, limit = 250) => {
		const content = String(value || "").replace(/\s+/g, " ").trim();
		if (/\.pdf\b/i.test(content)) return "[PDF filename]";
		return content.replace(/https?:\/\/\S+/gi, "[URL]").replace(/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/g, "[email]")
			.replace(/\+?\d[\d\s().-]{6,}\d/g, "[number]").slice(0, limit);
	};
	const attribute = (node, name) => node?.getAttribute?.(name) || "";
	const tag = (node) => String(node?.tagName || "").toUpperCase();
	const selectionDisplay = (node) => attribute(node, "role") === "combobox" || attribute(node, "aria-haspopup") === "listbox";
	function labelText(node) {
		if (!node) return "";
		if (!node.childNodes) return clean(node.innerText || node.textContent);
		const visit = (current) => {
			if (current.nodeType === 3) return current.nodeValue || "";
			if (current !== node && (/^(INPUT|TEXTAREA|SELECT|OPTION|BUTTON|SCRIPT|STYLE|NOSCRIPT)$/.test(tag(current))
				|| /^(combobox|listbox|option|radio|checkbox|status|alert|tooltip)$/.test(attribute(current, "role")))) return "";
			return [...(current.childNodes || [])].map(visit).join(" ");
		};
		return clean(visit(node));
	}
	function hooks(node) {
		const found = [];
		for (const name of ["data-field-path", "data-field-entry-id"]) if (node.hasAttribute?.(name)) found.push(name);
		for (const name of attribute(node, "class").split(/\s+/)) {
			if (/selected|checked|active|pressed|focus|hover|disabled|error|invalid|valid|touched/i.test(name)) continue;
			if (/^ashby-application-form-(?:field-entry|question-title|question-description)$/.test(name)) found.push(name);
			else {
				const match = name.match(/^_?(option|question|field|radio|choice|group|label|container|button)(?:[A-Z][A-Za-z]*)?[_-]/);
				if (match) found.push(`css-module:${match[1]}`);
			}
		}
		return [...new Set(found)].sort();
	}
	function byId(root, id) {
		if (root.getElementById) return root.getElementById(id);
		return [...root.querySelectorAll("[id]")].find((node) => node.id === id) || null;
	}
	function referencedLabels(node) {
		const root = node.getRootNode();
		return attribute(node, "aria-labelledby").split(/\s+/).filter(Boolean).slice(0, 10).map((id) => byId(root, id)).filter(Boolean);
	}
	function questionLabel(group, control) {
		if (group === control && selectionDisplay(control)) {
			const labels = [...(control.labels || [])].slice(0, 5);
			return { label: clean(labels.map(labelText).join(" ")), labelSource: labels.length ? "control-label" : "not-found", labels };
		}
		const aria = clean(attribute(group, "aria-label"));
		if (aria) return { label: aria, labelSource: "aria-label", labels: [] };
		const referenced = referencedLabels(group);
		if (referenced.length) return { label: clean(referenced.map(labelText).join(" ")), labelSource: "aria-labelledby", labels: referenced };
		const titles = [...group.querySelectorAll('legend, .ashby-application-form-question-title, label')].filter((node) => {
			if (node.closest(GROUPS) !== group) return false;
			if (node.querySelector(CONTROLS)) return false;
			return tag(node) === "LEGEND" || hooks(node).includes("ashby-application-form-question-title") || node.parentElement === group;
		}).filter((node) => labelText(node));
		const preferred = titles.filter((node) => tag(node) === "LEGEND" || hooks(node).includes("ashby-application-form-question-title"));
		const candidates = preferred.length ? preferred : titles;
		if (candidates.length === 1) return { label: labelText(candidates[0]), labelSource: "question-title", labels: candidates };
		if (candidates.length > 1) return { label: "", labelSource: "ambiguous-question-titles", labels: candidates.slice(0, 8) };
		const own = [...(control.labels || [])].slice(0, 5);
		if (group === control && own.length) return { label: clean(own.map(labelText).join(" ")), labelSource: "control-label", labels: own };
		return { label: "", labelSource: "not-found", labels: [] };
	}
	function inspect(document) {
		const ids = new WeakMap();
		let nextId = 0;
		const localId = (node) => { if (!ids.has(node)) ids.set(node, `n${++nextId}`); return ids.get(node); };
		const groups = new Map();
		const nativeNames = new WeakMap();
		let nativeCount = 0;
		let controlCount = 0;
		let truncated = false;
		const roots = [document];
		for (let index = 0; index < roots.length && index < 20; index++) {
			const root = roots[index];
			for (const node of root.querySelectorAll("*")) if (node.shadowRoot) {
				if (roots.length < 20) roots.push(node.shadowRoot);
				else truncated = true;
			}
			for (const control of root.querySelectorAll(CONTROLS)) {
				const type = String(attribute(control, "type") || control.type || "").toLowerCase();
				if (type === "hidden" || type === "password" || control.hidden || attribute(control, "aria-hidden") === "true" || control.closest("[hidden], [inert]")) continue;
				if (controlCount >= 500 || groups.size >= 100) { truncated = true; break; }
				controlCount++;
				const wrapper = control.closest(GROUPS) || control;
				if (!groups.has(wrapper)) {
					const title = questionLabel(wrapper, control);
					groups.set(wrapper, { id: localId(wrapper), label: title.label, labelSource: title.labelSource,
						wrapper: { tag: tag(wrapper), role: attribute(wrapper, "role") || null, structuralHooks: hooks(wrapper) },
						labelReferences: title.labels.map((label) => ({ id: localId(label), tag: tag(label), label: labelText(label), structuralHooks: hooks(label) })),
						stateAttributeNames: new Set(), controls: [] });
				}
				const group = groups.get(wrapper);
				for (const name of STATE_NAMES) if (control.hasAttribute?.(name)) group.stateAttributeNames.add(name);
				const labels = referencedLabels(control);
				const nativeLabels = [...(control.labels || [])].slice(0, 5);
				const attachment = type === "file" || ATTACHMENT.test(group.label);
				const currentSelectionDisplay = selectionDisplay(control);
				let label = clean(attribute(control, "aria-label")) || clean(labels.map(labelText).join(" ")) || clean(nativeLabels.map(labelText).join(" "));
				if (!label && (tag(control) === "BUTTON" || /^(radio|checkbox|option)$/.test(attribute(control, "role")))) label = labelText(control);
				if (attachment || currentSelectionDisplay) label = "";
				const item = { id: localId(control), groupId: group.id, tag: tag(control), type: type || null,
					explicitType: attribute(control, "type") || null, formId: control.form ? localId(control.form) : null,
					role: attribute(control, "role") || null, label, structuralHooks: hooks(control),
					labelReferences: [...new Set([...labels, ...nativeLabels])].map(localId) };
				if (type === "radio") {
					const owner = control.form || root;
					if (!nativeNames.has(owner)) nativeNames.set(owner, new Map());
					const names = nativeNames.get(owner);
					const name = attribute(control, "name");
					if (name) { if (!names.has(name)) names.set(name, `r${++nativeCount}`); item.nativeGroupId = names.get(name); }
				}
				if (tag(control) === "SELECT") item.options = [...control.options].slice(0, 50).map((option) => ({ label: labelText(option) }));
				group.controls.push(item);
			}
		}
		let origin = "";
		try { origin = new URL(document.URL).origin; } catch { /* No page address is exported if unreadable. */ }
		const questions = [];
		let budget = 180000;
		for (const group of groups.values()) {
			const output = { ...group, stateAttributeNames: [...group.stateAttributeNames].sort(), controls: [] };
			budget -= JSON.stringify(output).length;
			if (budget < 0) { truncated = true; break; }
			for (const control of group.controls) {
				budget -= JSON.stringify(control).length + 1;
				if (budget < 0) { truncated = true; break; }
				output.controls.push(control);
			}
			questions.push(output);
			if (budget < 0) break;
		}
		return { origin, questions, truncated };
	}
	globalThis.ReactiveResumeDiagnostics = Object.freeze({ inspect });
})();
