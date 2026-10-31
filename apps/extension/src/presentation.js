/* global chrome */
import { mountTooltips } from "./tooltips.js";

const THEME_KEY = "extensionTheme";

const savedTheme = (value) => value === "light" || value === "dark" ? value : null;

export async function mountTheme({ document, chromeApi }) {
	const view = document.defaultView;
	const media = view.matchMedia?.("(prefers-color-scheme: dark)");
	const button = document.getElementById("theme-toggle");
	const status = document.getElementById("appearance-status");
	let preference = null;
	let theme = media?.matches ? "dark" : "light";
	let revision = 0;
	let disposed = false;
	const apply = (value) => {
		theme = value;
		document.documentElement.dataset.theme = theme;
		if (button) {
			const label = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
			button.setAttribute("aria-label", label);
			button.setAttribute("aria-pressed", String(theme === "dark"));
			button.setAttribute("data-tooltip", label + ".");
		}
	};
	const followSystem = () => { if (!preference) apply(media?.matches ? "dark" : "light"); };
	const onStorage = (changes, area) => {
		if (area !== "local" || !changes[THEME_KEY] || disposed) return;
		revision++;
		preference = savedTheme(changes[THEME_KEY].newValue);
		apply(preference || (media?.matches ? "dark" : "light"));
	};
	const onToggle = async () => {
		revision++;
		preference = theme === "dark" ? "light" : "dark";
		apply(preference);
		if (status) { status.hidden = true; status.textContent = ""; }
		try {
			await chromeApi.storage.local.set({ [THEME_KEY]: preference });
		} catch {
			if (status) {
				status.hidden = false;
				status.textContent = "Appearance changed for this window; the preference could not be saved.";
			}
		}
	};
	apply(theme);
	button?.addEventListener("click", onToggle);
	media?.addEventListener?.("change", followSystem);
	chromeApi.storage.onChanged?.addListener(onStorage);
	try {
		const result = await chromeApi.storage.local.get({ [THEME_KEY]: null });
		if (!revision && !disposed) {
			preference = savedTheme(result[THEME_KEY]);
			apply(preference || (media?.matches ? "dark" : "light"));
		}
	} catch {
		// An unavailable saved preference must not block forms or the current theme.
	}
	return () => {
		disposed = true;
		button?.removeEventListener("click", onToggle);
		media?.removeEventListener?.("change", followSystem);
		chromeApi.storage.onChanged?.removeListener(onStorage);
	};
}

export function mountFeedback({ document }) {
	const view = document.defaultView;
	if (!view.MutationObserver) return () => {};
	const message = document.getElementById("message");
	const fileStates = new Map();
	const lastFiles = new Map();
	const busyActions = new Set(["capture", "load", "more", "preview", "fill", "diagnostics", "test", "sync", "retry"]);
	const activeButtons = new Set();
	let lastMessage = "";
	const pulse = (element) => {
		if (view.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
		element.classList.remove("feedback-in");
		view.requestAnimationFrame(() => { if (element.isConnected) element.classList.add("feedback-in"); });
	};
	const sync = () => {
		for (const button of activeButtons) {
			const busy = button.isConnected && button.disabled;
			if (button.classList.contains("is-busy") !== busy) button.classList.toggle("is-busy", busy);
			if (busy && button.getAttribute("aria-busy") !== "true") button.setAttribute("aria-busy", "true");
			if (!busy) {
				if (button.getAttribute("aria-busy") !== null) button.removeAttribute("aria-busy");
				activeButtons.delete(button);
			}
		}
		if (message) {
			const text = message.textContent.trim();
			const busy = /^(Loading|Reading|Preparing|Filling|Saving|Uploading|Connecting|Syncing)\b/i.test(text);
			const attention = /[1-9]\d* need attention/iu.test(text);
			const complete = /^(?:[1-9]\d* prepared jobs? loaded|[1-9]\d* fields filled.*?0 need attention|Approved profile and answers saved|Settings saved|Description copied|Diagnostics downloaded|Connected\.|This application.*cleared|Draft restored|Saved\b|Captured\b)/iu.test(text);
			const kind = message.classList.contains("error") ? "error" : busy ? "busy"
				: attention ? "attention" : complete ? "success" : "neutral";
			if (message.dataset.feedback !== kind) message.dataset.feedback = kind;
			if (text && text !== lastMessage && !busy) pulse(message);
			lastMessage = text;
		}
		for (const [id, statusId] of [["pdf", "pdf-status"], ["cover-letter", "cover-letter-status"]]) {
			const input = document.getElementById(id);
			const status = document.getElementById(statusId);
			if (!input || !status) continue;
			const text = status.textContent.trim();
			const selected = Boolean(input.files?.length) && /^Selected/u.test(text);
			if (fileStates.get(id) !== selected) {
				input.classList.toggle("file-ready", selected);
				status.classList.toggle("file-selected", selected);
				fileStates.set(id, selected);
			}
			if (selected && lastFiles.get(id) !== text) pulse(status);
			lastFiles.set(id, text);
		}
	};
	const onClick = (event) => {
		const button = event.target.closest?.("button");
		if (!button || !busyActions.has(button.id)) return;
		activeButtons.add(button);
		sync();
	};
	const observer = new view.MutationObserver(sync);
	observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["disabled", "class"] });
	document.addEventListener("click", onClick);
	sync();
	return () => {
		observer.disconnect();
		document.removeEventListener("click", onClick);
		for (const button of activeButtons) {
			button.classList.remove("is-busy");
			button.removeAttribute("aria-busy");
		}
		activeButtons.clear();
	};
}

if (globalThis.document && globalThis.chrome) {
	const mode = new URL(document.location.href).searchParams.get("mode");
	if (mode === "window" || mode === "sidepanel") document.body.dataset.mode = mode;
	void mountTheme({ document, chromeApi: chrome });
	mountFeedback({ document });
	if (document.body.classList.contains("settings")) mountTooltips({ document });
}
