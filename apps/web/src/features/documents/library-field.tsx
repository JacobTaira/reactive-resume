import type { ChangeEvent } from "react";
import { useId } from "react";
import { Input } from "@reactive-resume/ui/components/input";
import { Label } from "@reactive-resume/ui/components/label";
import { Textarea } from "@reactive-resume/ui/components/textarea";

type LibraryFieldProps = {
	label: string;
	value: string;
	onChange: (value: string) => void;
	maxLength: number;
	placeholder?: string;
	hint?: string;
	multiline?: boolean;
	className?: string;
	type?: "text" | "url" | "date";
	required?: boolean;
};

/** Consistent labeled text fields in the resume and company research forms. */
export function LibraryField({ label, value, onChange, hint, multiline, type = "text", ...props }: LibraryFieldProps) {
	const id = useId();
	const fieldProps = {
		...props,
		id,
		value,
		"aria-describedby": hint ? `${id}-hint` : undefined,
		onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(event.target.value),
	};
	return (
		<div className="grid gap-1.5">
			<Label htmlFor={id}>
				{label}
			</Label>
			{multiline ? <Textarea {...fieldProps} /> : <Input {...fieldProps} type={type} />}
			{hint && <p id={`${id}-hint`} className="text-xs text-ink-3">
				{hint}
			</p>}
		</div>
	);
}
