import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import type { Extension } from "@codemirror/state";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { Annotation, Compartment, EditorState } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useTheme } from "@/features/theme/provider";

const replacement = Annotation.define<boolean>();
const latex = StreamLanguage.define({
	token(stream) {
		if (stream.match(/%.*/)) return "comment";
		if (stream.match(/\\(?:[A-Za-z@]+|.)/)) return "keyword";
		if (stream.match(/[{}[\]]/)) return "bracket";
		if (stream.match(/\$\$?/)) return "string";
		if (stream.match(/\d+(?:\.\d+)?/)) return "number";
		stream.next();
		return null;
	},
});

const highlightStyle = HighlightStyle.define([
	{ tag: tags.keyword, color: "var(--info-text)" },
	{ tag: tags.comment, color: "var(--ink-3)", fontStyle: "italic" },
	{ tag: tags.bracket, color: "var(--ink-2)" },
	{ tag: tags.string, color: "var(--accent-text)" },
	{ tag: tags.number, color: "var(--warn-text)" },
]);

/** Set both CodeMirror's theme mode and explicit caret colors: its default cursor is dark. */
const editorTheme = (dark: boolean): Extension => EditorView.theme({
	"&": { height: "100%", backgroundColor: "var(--raised)", color: "var(--ink)", direction: "ltr" },
	".cm-scroller": { overflow: "auto", fontFamily: "var(--font-mono)", fontSize: "13px", lineHeight: "1.65" },
	".cm-content": { minHeight: "100%", padding: "1rem 0", caretColor: "var(--ink)" },
	".cm-line": { padding: "0 0.75rem" },
	".cm-gutters": { backgroundColor: "var(--sunken)", color: "var(--ink-3)", borderRight: "1px solid var(--line)", minWidth: "3rem" },
	".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--hover)" },
	".cm-activeLineGutter": { color: "var(--ink)" },
	".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--ink)", borderLeftWidth: "2px" },
	".cm-selectionBackground": { backgroundColor: "color-mix(in srgb, var(--info-text) 18%, transparent)" },
	"&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-content ::selection": {
		backgroundColor: "color-mix(in srgb, var(--info-text) 28%, transparent)",
	},
	"&.cm-focused": { outline: "none", boxShadow: "inset 0 0 0 1px var(--accent)" },
}, { dark });

type LatexCodeEditorProps = {
	value: string;
	readOnly: boolean;
	label: string;
	onChange: (value: string) => void;
};

/** External MCP edits replace the text without recreating the editor on each local keystroke. */
export function LatexCodeEditor({ value, readOnly, label, onChange }: LatexCodeEditorProps) {
	const { resolvedTheme } = useTheme();
	const container = useRef<HTMLDivElement>(null);
	const view = useRef<EditorView | null>(null);
	const initial = useRef({ value, readOnly, label, theme: resolvedTheme });
	const change = useRef(onChange);
	const permissions = useRef(new Compartment());
	const theme = useRef(new Compartment());

	useLayoutEffect(() => { change.current = onChange; }, [onChange]);

	useEffect(() => {
		if (!container.current) return;
		const editor = new EditorView({
			parent: container.current,
			state: EditorState.create({
				doc: initial.current.value,
				extensions: [
					lineNumbers(), history(), drawSelection(), highlightActiveLine(), highlightActiveLineGutter(), highlightSpecialChars(), latex,
					syntaxHighlighting(highlightStyle), EditorView.lineWrapping,
					keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
					EditorView.editorAttributes.of({ dir: "ltr" }),
					EditorView.contentAttributes.of({ "aria-label": initial.current.label, dir: "ltr", spellcheck: "false" }),
					permissions.current.of([
						EditorState.readOnly.of(initial.current.readOnly), EditorView.editable.of(!initial.current.readOnly),
					]),
					theme.current.of(editorTheme(initial.current.theme === "dark")),
					EditorView.updateListener.of((update) => {
						if (update.docChanged && !update.transactions.some((transaction) => transaction.annotation(replacement))) {
							change.current(update.state.doc.toString());
						}
					}),
				],
			}),
		});
		view.current = editor;
		return () => { editor.destroy(); view.current = null; };
	}, []);

	useEffect(() => {
		const editor = view.current;
		if (!editor || editor.state.doc.toString() === value) return;
		editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value }, annotations: replacement.of(true) });
	}, [value]);

	useEffect(() => {
		view.current?.dispatch({ effects: permissions.current.reconfigure([
			EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly),
		]) });
	}, [readOnly]);

	useEffect(() => {
		view.current?.dispatch({ effects: theme.current.reconfigure(editorTheme(resolvedTheme === "dark")) });
	}, [resolvedTheme]);

	return <div ref={container} className="h-full min-h-0 overflow-hidden" />;
}
