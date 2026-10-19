// @vitest-environment happy-dom
import type { LatexCompileChecks } from "@reactive-resume/schema/resume/latex";
import { render, screen } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { LatexPdfChecks } from "./compile-checks";

const clean: LatexCompileChecks = {
	pageCount: 5,
	expectedPageCount: null,
	pageCountMatches: null,
	pageCountError: null,
	overfullBoxes: { count: 0, messages: [], truncated: false },
	textExtraction: { status: "success", characterCount: 500, text: "Resume evidence", preview: "Resume evidence", truncated: false, error: null },
};

beforeEach(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

function show(checks: LatexCompileChecks | undefined, stale = false) {
	render(<I18nProvider i18n={i18n}><LatexPdfChecks checks={checks} stale={stale} /></I18nProvider>);
}

it("reports absent diagnostics from an older worker as unavailable", () => {
	show(undefined);
	expect(screen.getByRole("status")).toHaveTextContent("Automatic PDF checks are unavailable");
	expect(screen.queryByText("No issues detected by these checks")).toBeNull();
});

it("reports multiple pages without assuming a one-page limit", () => {
	show(clean);
	expect(screen.getByText("Pages: 5. No page target set.")).toBeInTheDocument();
	expect(screen.getByText("Extracted characters: 500.")).toBeInTheDocument();
	expect(screen.getByText("No issues detected by these checks")).toBeInTheDocument();
});

it("surfaces a page mismatch, overflow and empty extraction for review", () => {
	show({
		...clean,
		expectedPageCount: 4,
		pageCountMatches: false,
		overfullBoxes: { count: 1, messages: ["Overfull \\hbox (2pt too wide)"], truncated: false },
		textExtraction: { ...clean.textExtraction, status: "empty", characterCount: 0, text: "", preview: "" },
	});
	expect(screen.getByText("Page count differs from the target.")).toBeInTheDocument();
	expect(screen.getByText(/Overfull box warnings: 1/)).toBeInTheDocument();
	expect(screen.getByText("No readable text was extracted.")).toBeInTheDocument();
	expect(screen.getByText("Review warnings")).toBeInTheDocument();
});

it("identifies extraction failures and checks for a previous compilation", () => {
	show({ ...clean, textExtraction: { ...clean.textExtraction, status: "failed", characterCount: null, text: "", preview: "", error: "Could not inspect PDF." } }, true);
	expect(screen.getByText("Text extraction failed.")).toBeInTheDocument();
	expect(screen.getByText("These checks describe the last compilation.")).toBeInTheDocument();
	expect(screen.queryByText("No issues detected by these checks")).toBeNull();
});
