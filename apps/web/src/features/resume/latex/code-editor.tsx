import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { defaultHighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { Annotation, Compartment, EditorState } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view";
import { useEffect, useLayoutEffect, useRef } from "react";

const replacement = Annotation.define<boolean>();
const latex = StreamLanguage.define({
	token(stream) {
		if (stream.match(/%.*/)) return "comment";
		if (stream.match(/\\(?:[A-Za-z@]+|.)/)) return "keyword";
		if (stream.match(/[{}[\]]/)) return "bracket";
		if (stream.match(/\$\$?/)) return "string";
		stream.next();
		return null;
	},
});

type LatexCodeEditorProps = {
	value: string;
	readOnly: boolean;
	label: string;
	onChange: (value: string) => void;
};

/** External MCP edits replace the text without recreating the editor on each local keystroke. */
export function LatexCodeEditor({ value, readOnly, label, onChange }: LatexCodeEditorProps) {
	const container = useRef<HTMLDivElement>(null);
	const view = useRef<EditorView | null>(null);
	const initial = useRef({ value, readOnly, label });
	const change = useRef(onChange);
	const permissions = useRef(new Compartment());

	useLayoutEffect(() => { change.current = onChange; }, [onChange]);

	useEffect(() => {
		if (!container.current) return;
		const editor = new EditorView({
			parent: container.current,
			state: EditorState.create({
				doc: initial.current.value,
				extensions: [
					lineNumbers(), history(), drawSelection(), highlightActiveLine(), latex,
					syntaxHighlighting(defaultHighlightStyle), EditorView.lineWrapping,
					keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
					EditorView.contentAttributes.of({ "aria-label": initial.current.label, spellcheck: "false" }),
					permissions.current.of([
						EditorState.readOnly.of(initial.current.readOnly), EditorView.editable.of(!initial.current.readOnly),
					]),
					EditorView.theme({
						"&": { height: "100%", backgroundColor: "var(--surface)", color: "var(--ink)" },
						".cm-scroller": { overflow: "auto", fontFamily: "var(--font-mono)", fontSize: "13px", lineHeight: "1.6" },
						".cm-content": { padding: "1rem 0" },
						".cm-gutters": { backgroundColor: "var(--sunken)", color: "var(--ink-3)", borderRight: "1px solid var(--line)" },
						".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--hover)" },
						"&.cm-focused": { outline: "none" },
					}),
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

	return <div ref={container} className="h-full min-h-0 overflow-hidden" />;
}
