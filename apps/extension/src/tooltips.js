// Popup help appears after deliberate hover or keyboard focus, without taking focus.
export function mountTooltips({ document, delay = 1200 }) {
	const view = document.defaultView;
	const tooltip = document.createElement("div");
	let suffix = 1;
	let id = "rr-popup-tooltip";
	while (document.getElementById(id)) id = `rr-popup-tooltip-${++suffix}`;
	tooltip.id = id;
	tooltip.className = "popup-tooltip";
	tooltip.setAttribute("role", "tooltip");
	tooltip.hidden = true;
	document.body.append(tooltip);
	let target = null;
	let showTimer = null;
	let hideTimer = null;
	const listeners = [];
	const listen = (element, type, listener, options) => {
		element.addEventListener(type, listener, options);
		listeners.push(() => element.removeEventListener(type, listener, options));
	};
	const clearTimers = () => {
		if (showTimer !== null) view.clearTimeout(showTimer);
		if (hideTimer !== null) view.clearTimeout(hideTimer);
		showTimer = hideTimer = null;
	};
	const hide = () => {
		clearTimers();
		if (target) {
			const descriptions = (target.getAttribute("aria-describedby") || "").split(/\s+/).filter((value) => value && value !== id);
			if (descriptions.length) target.setAttribute("aria-describedby", descriptions.join(" "));
			else target.removeAttribute("aria-describedby");
		}
		target = null;
		tooltip.hidden = true;
	};
	const show = () => {
		showTimer = null;
		if (!target?.isConnected) { hide(); return; }
		tooltip.textContent = target.getAttribute("data-tooltip");
		tooltip.hidden = false;
		const descriptions = new Set((target.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean));
		descriptions.add(id);
		target.setAttribute("aria-describedby", [...descriptions].join(" "));
		const anchor = target.getBoundingClientRect();
		const bounds = tooltip.getBoundingClientRect();
		const width = document.documentElement.clientWidth || view.innerWidth;
		const height = document.documentElement.clientHeight || view.innerHeight;
		const clamp = (value, size, extent) => Math.max(8, Math.min(value, extent - size - 8));
		const below = anchor.bottom + 8;
		const top = below + bounds.height <= height - 8 ? below : anchor.top - bounds.height - 8;
		tooltip.style.left = `${clamp(anchor.left + (anchor.width - bounds.width) / 2, bounds.width, width)}px`;
		tooltip.style.top = `${clamp(top, bounds.height, height)}px`;
	};
	const schedule = (element) => {
		if (target === element) {
			if (hideTimer !== null) view.clearTimeout(hideTimer);
			hideTimer = null;
			return;
		}
		hide();
		target = element;
		showTimer = view.setTimeout(show, delay);
	};
	const leave = (event) => {
		if (event.relatedTarget && tooltip.contains(event.relatedTarget)) return;
		if (showTimer !== null || tooltip.hidden) { hide(); return; }
		// A short grace period lets the pointer cross the gap into the help itself.
		if (hideTimer !== null) view.clearTimeout(hideTimer);
		hideTimer = view.setTimeout(hide, 100);
	};
	for (const element of document.querySelectorAll("[data-tooltip]")) {
		listen(element, "mouseenter", () => schedule(element));
		listen(element, "focus", () => schedule(element));
		listen(element, "mouseleave", leave);
		listen(element, "blur", hide);
		listen(element, "click", hide);
	}
	listen(tooltip, "mouseenter", () => {
		if (!tooltip.hidden && hideTimer !== null) { view.clearTimeout(hideTimer); hideTimer = null; }
	});
	listen(tooltip, "mouseleave", hide);
	listen(document, "keydown", (event) => { if (event.key === "Escape") hide(); });
	listen(document, "scroll", hide, true);
	listen(view, "resize", hide);
	return () => { hide(); for (const remove of listeners) remove(); tooltip.remove(); };
}
