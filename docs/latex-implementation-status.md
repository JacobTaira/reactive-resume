# LaTeX resume support: implementation status

This feature preserves a resume's PDFLaTeX source instead of converting it into Reactive Resume's form fields. It reuses the dashboard, document duplication, autosave, versions, application links, and MCP connection.

## Implemented

- Optional source project in the resume schema, with file and project limits.
- Isolated compiler worker and optional Docker Compose service.
- Import of a standalone `.tex` file or an Overleaf source ZIP.
- Source editor, file selection, compile log, PDF preview, source downloads, and extracted-text review.
- PDF export dispatch for LaTeX documents, including authenticated and public PDF downloads.
- MCP compilation tool and instructions for editing source through existing resume tools.
- Public resume responses redact source files and comments.
- Mobile public links show the compiled PDF instead of empty form fields.
- Structured cover-letter exports do not inherit the resume's LaTeX source.
- Regression tests for schema round trips, imports, compiler requests, export selection, redaction, and MCP compilation.
- Local setup and Claude Code instructions in `docs/guides/using-latex.mdx`.

## Verified

- All 16 Python worker tests pass, including actual PDFLaTeX compilations, invalid source, process timeouts, file access restrictions, archive limits, and HTTP authentication.
- The supplied source compiles and preserves the original text (ignoring whitespace), Charter font faces, and US Letter size. Private inputs and validation output are excluded from commits.
- Modified TypeScript and TSX files parse successfully with the available Babel parser. This is a syntax check, not a TypeScript typecheck.
- `git diff --check` passes.

## Remaining verification

- Install the locked workspace dependencies, then run the new Vitest suites, affected-package typechecks, `pnpm lint:agent`, `pnpm format:check`, Lingui extraction, API documentation generation, and the production build.
- Run a Docker/browser smoke test: import, edit, autosave, duplicate, compile, download, restore a version, and link a tailored resume to an application.
- Match the TeX environment before claiming identical Overleaf pagination. The available older PDFLaTeX produces five pages for the supplied source, compared with four in the reference PDF; text and fonts match.

## Environment limits

The checkout has no installed workspace dependencies or Docker executable. Offline install is missing cached packages; online install returns registry HTTP 403 errors. Attempts to run typecheck, lint, format, and build cannot reach their tools because pnpm first attempts the blocked dependency install. Full application verification therefore remains pending. No application checks are represented as passed.

## Checkpoint

Work is tracked on `feat/latex-resume-support`. A recovery Git bundle and patch are available alongside the local checkout. The feature remains a draft until the remaining application checks and visual comparisons pass. Publishing this branch does not deploy the hosted service.

## Scope

Initial engine: PDFLaTeX. Arbitrary LaTeX does not synchronize with the form editor. Custom fonts requiring XeLaTeX or LuaLaTeX, executable build scripts, and bibliography toolchains are outside this first version.
