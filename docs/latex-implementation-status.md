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
- Adjustable source/PDF panes with keyboard controls, saved sizing, theme-aware highlighting, and a visible caret.
- Owned nested resume folders, master/tailored metadata, source lineage, dated evaluations, and compact related-resume/job discovery.
- A separate company research area with one revision-protected document per company, dated sources, and matching MCP tools.
- Account export includes organization, company research, and resume library metadata. The library fields remain private on public resume routes.
- Requirement evidence maps with quoted owned-resume citations, assistant-recorded change rationale, and draft/direct-source review snapshots.
- Read-only saved-source comparison through MCP, including explicit historical source-version selection and bounded/coarse comparison flags. Change rationale remains separate from computed differences.
- Compiler diagnostics for page count, an optional expected count, overfull box warnings and bounded PDF text extraction. Older workers with no checks remain explicitly unverified.
- User-reported resume outcomes and related-resume reuse hints. Recorded hiring results are contextual observations, not causal evidence about resume quality; new drafts do not inherit them.
- Career navigation and section removed; old links redirect to Applications, with Companies available in the mobile navigation.
- Job-saving guidance now comes before research and resume reads, verifies the saved Applications record, retains unknown details with explicit placeholders and reports unconfirmed writes. Prompt retrieval no longer reads a master eagerly. External assistant execution remains outside the app's control.
- Capture-queue MCP contracts and an explicit `process_tailoring_queue` prompt: shared-gap preflight, user-confirmed master corrections, expiring per-job claims, resumable drafts, revision-guarded preparation notes and explicit Ready/Failed completion. Creating a copy does not finish preparation or mark an application Applied. Installation and recovery steps are in `docs/guides/capture-queue.mdx`.

## Verified

- All 28 Python worker tests pass, including actual PDFLaTeX compilations, page count and expected-count checks, final-pass overflow warnings, text extraction and unavailable-tool behavior, invalid source, process timeouts, file access restrictions, archive limits, and HTTP authentication.
- The supplied source compiles and preserves the original text (ignoring whitespace), Charter font faces, and US Letter size. Private inputs and validation output are excluded from commits.
- Modified TypeScript and TSX files parse successfully with the available Babel parser. This is a syntax check, not a TypeScript typecheck.
- `git diff --check` passes.
- Offline native checks exercise folder navigation, metadata patch behavior, lexical ranking, stale evaluations, external tailoring instructions, actual source comparison, and evidence/outcome contracts. DTO checks use an available bundled Zod 4.4.3 rather than the project's locked 4.6.7; they do not establish compatibility with every installed dependency. Full MCP SDK execution and Vitest remain pending.
- The additive library migration's SQL and snapshot have been checked for existing-schema preservation and matching tables, columns, constraints, and indexes. PostgreSQL execution remains unverified.
- All 18 dependency-free extension tests pass, including actual worker code under Chrome/network mocks for settings opened in a browser tab, restart recovery, lost responses, partial batch failures, credential isolation and bulk progress races. Four extraction fixtures pass through an lxml-backed Document adapter; this is not a Chrome test.
- Native adapters exercise capture/queue transactions, permission/validation policies, shared-gap instructions and atomic draft creation/reuse against production source. Database/auth boundaries are mocked. The capture migration preserves all 741 prior snapshot entries and adds three nullable columns and two indexes; real PostgreSQL execution remains pending.

## Remaining verification

- Install the locked workspace dependencies, then run the new Vitest suites, affected-package typechecks, `pnpm lint:agent`, `pnpm format:check`, Lingui extraction, API documentation generation, and the production build.
- Run a Docker/browser smoke test: import, edit, autosave, duplicate, compile, download, restore a version, and link a tailored resume to an application.
- Load the Chrome extension unpacked, capture an actual posting, check duplicate/offline recovery, then process it through the authenticated MCP connection. Test signed-in Jobright Liked pagination, extraction, pause/resume and the reported discovery limits. No real Chrome or signed-in Jobright end-to-end run was possible here.
- Exercise requirement citations, rationale notes, current/historical source comparisons, stale review conflicts, unavailable/mismatched PDF checks, and user-reported outcomes through both website and MCP. Confirm generated drafts never inherit an earlier outcome and do not submit applications.
- Review snapshots guard resume content and its direct source. Job metadata has no independent revision guard yet; concurrent chats should reread job context before saving a new assessment. A metadata revision guard remains a follow-up.
- Match the TeX environment before claiming identical Overleaf pagination. The available older PDFLaTeX produces five pages for the supplied source, compared with four in the reference PDF; text and fonts match.

## Environment limits

The checkout has no installed workspace dependencies or Docker executable. Offline install is missing cached packages; online install returns registry HTTP 403 errors. Attempts to run typecheck, lint, format, and build cannot reach their tools because pnpm first attempts the blocked dependency install. Full application verification therefore remains pending. No application checks are represented as passed.

## Checkpoint

Work is tracked on `feat/latex-resume-support`. A recovery Git bundle and patch are available alongside the local checkout. The feature remains a draft until the remaining application checks and visual comparisons pass. Publishing this branch does not deploy the hosted service.

## Scope

Initial engine: PDFLaTeX. Arbitrary LaTeX does not synchronize with the form editor. Custom fonts requiring XeLaTeX or LuaLaTeX, executable build scripts, and bibliography toolchains are outside this first version.
