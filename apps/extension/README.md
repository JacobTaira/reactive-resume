# Reactive Resume Capture and Autofill

Manifest V3 Chrome extension for your own Reactive Resume installation. Capture uses deterministic extraction; autofill uses your approved profile and exact approved answers. Neither calls an AI provider or consumes Jobright credits. The extension never submits an application or marks it Applied.

## Install on Windows Chrome

1. Update your fork checkout and start the local Reactive Resume website.
2. Open `chrome://extensions`, enable **Developer mode**, then click **Load unpacked**.
3. Choose this `apps/extension` folder. For an Ubuntu WSL checkout, browse to `\\wsl.localhost\Ubuntu\home\jacob\reactive-resume-latex\apps\extension`; substitute your actual distro and home directory.
4. Pin **Reactive Resume Capture and Autofill** to Chrome's toolbar. Open its Details → Extension options for capture settings.
5. Set **Installation URL** to `http://localhost:3000`. Create a capture-only API key in Reactive Resume's API settings and enter it under **Capture-only API key**. Click **Save settings and grant access**, approve access to your installation, then **Test connection**.

No Node installation or extension build is needed to load the checked-in folder. After pulling extension changes, click Reload on its `chrome://extensions` card and reload open Jobright tabs.

## Capture a job

Open its page, click the toolbar button and choose **Save this job to the queue**, or press **Ctrl+Shift+Y**. The extension reads the rendered page: matching JobPosting JSON-LD first, Jobright sections next, selected text or main page text last. The fallback needs review and can include unrelated page text. Company/role fallback values are flagged.

## Fill an application without Jobright credits

In the popup, **Resume source** contains jobs added by **Load prepared jobs**, alongside the manual-PDF option. If none are prepared yet, use **Copy Claude prompt** in Reactive Resume’s **Applications → Queue** first, or select a PDF manually. Hover over a popup action, settings link, Resume source or the PDF section for about a second to see help; keyboard focus shows the same help. Press Escape to dismiss it.

Choose **Open in window** to keep the assistant open while clicking elsewhere. Drag the window edges to resize it. This window stays linked to the application tab you opened it from; **Show application** brings that tab forward. Switching to another tab or window does not redirect Autofill there. A changed application URL loads its own draft and needs a fresh preview. If the linked tab closes or moves to another website, open the extension on the intended application again.

Use the moon/sun button to switch between light and dark mode. The preference is saved across the assistant and both settings pages. Until you choose a mode, appearance follows your system setting. Wheel and keyboard scrolling still work with the scrollbar hidden; feedback animations respect reduced-motion preferences.

1. Open the toolbar popup and choose **Autofill settings**. Enter the profile facts you approve for applications. Your Google Doc remains the authority for background facts; autofill does not read or interpret it automatically.
2. To select saved jobs and their linked PDFs, enter your installation URL and a separate **normal MCP API key**. The capture-only key cannot read resumes or applications. Use the same installation origin as `APP_URL` so its signed PDF links resolve correctly. Alternatively, leave the MCP key empty and choose a PDF manually in the popup.
3. Add recurring answers as explicit question/answer pairs. They match the complete question, ignoring punctuation/case. An optional `applicationId` restricts an answer to one saved job. Repeated history questions require the `fieldId` displayed in the preview; combine it with `applicationId` to approve the correct entry. Set `approved: false` to retain an answer without using it. Unknown screening answers, consent choices and demographic fields remain untouched unless you explicitly approved an exact answer.
4. Open the employer's actual application form. In the popup, choose **Load prepared jobs**, select the intended company and role, then **Preview fields**. A saved application supplies its linked resume; a manually selected PDF overrides that attachment for this preview only.
5. Review the displayed company, role, PDF filename and proposed field values. Uncheck any matched field you do not want filled. Choose **Fill selected empty fields**. Existing form values are preserved.
6. Review the employer's page, confirm its PDF upload finished, complete unsupported controls and click its final Submit button yourself. On every new form step, open the popup and preview again. Company, role, loaded jobs, selected job, manual PDF and reviewed field checkboxes are saved automatically for the exact same tab and URL. Clicking onto the application and reopening the popup restores this draft. A different URL or tab has a separate draft. Use **Clear this draft** to remove this page's choices and manual PDF.

**Common answers:** Autofill settings includes blank/manual defaults for job source, prior government employment, gender, a combined U.S. EEO race/ethnicity category, and protected-veteran status. Explicitly save only the answers you want reused for recognized equivalent questions. Exact/scoped answers override these defaults. Prior/current/federal-only government work, gender/sex-at-birth, combined race/ethnicity/separate ethnicity, protected-veteran status/general military service and multi-select checkbox groups are not interchangeable. No demographic answer is inferred. Review every preview, including a default job source that may differ by job.

**Optional cover letter:** Expand **Resume and optional cover letter PDFs** in the popup to select a separate PDF for that job. It has its own previewed filename and digest, is retained with the tab draft, and fills only clearly labelled cover-letter uploads. The resume is never reused as a cover letter. Both files must still finish uploading on the employer's page.

**Ashby choices:** Supported question-title labels include the native demographic fieldset structure without a legend. Known Yes/No widgets use their actual option buttons and backing answered state, rather than treating an unchecked checkbox as No. Generic buttons are excluded; form-associated submit-capable choices are refused and safety is rechecked at the click.

**Missed controls:** Choose **Download form diagnostics** to explicitly download a bounded JSON report of question/option labels, grouping, structural control hooks, extension version and saved common-answer category names. It works without a PDF and does not fill or submit anything. The report excludes entered values, selected-state values, profile/answer contents, credentials, files and private URL paths/query strings. It is not saved into tab drafts or sent anywhere automatically. Review the file before sharing it. This is more useful than a printed PDF for debugging an unknown widget's DOM structure.

Example approved answers (replace fictional values with your confirmed information):

```json
[
  { "question": "When can you start?", "answer": "My confirmed availability" },
  { "question": "Why are you interested in this company?", "answer": "My reviewed job-specific answer", "applicationId": "saved-application-id" }
]
```

Autofill supports labelled native fields, selects, exact approved radio choices, resume file inputs, open Shadow DOM, and some ARIA dropdowns. It operates in the main page and frames Chrome permits the extension to access. Complex controls and inaccessible embedded forms may need manual entry or opening the application form directly. It does not promise every job site is supported. File selection is checked, but the employer's upload confirmation remains the final check.

Profiles, answers and keys are restricted to trusted extension contexts. Employer pages receive only the approved information needed to fill the form, never your installation API key or signed PDF download URL. Previews last ten minutes and are bound to the tab, document, form fields, approved profile and PDF. A stopped background worker can recover the preview from browser-session storage and verify that a downloaded PDF still matches the previewed file. Navigation, changed linkage, changed approvals, changed PDF bytes or changed form fields requires another preview.

Popup drafts use extension-local IndexedDB to retain the selected manual PDF without base64 expansion or session-storage quota limits. A browser-session identifier and exact tab/URL keep the draft tied to its application. Closing the popup preserves it; **Clear this draft** or closing the employer tab removes it. Drafts older than 24 hours and drafts from a previous browser/extension session are pruned when draft storage next opens. API keys and signed download URLs are never included in a draft. The lightweight worker preview still stores only a PDF digest and metadata in session storage.

On Jobright, capture waits briefly for loading content, reads section bodies across nested wrappers, and uses matching posting-title/company metadata. Known skill-selection help is removed. When that help precedes explicit Required or Preferred sections, the personalized skill chips are omitted too; the employer's requirements remain. Headings, the skills legend, and selection help alone are not a description. Missing section bodies keep useful partial text under Needs details rather than allowing an unfinished capture into preparation.

The capture is saved to a durable browser outbox before upload. A waiting badge means it is retained locally; **Saved in Applications**, an application ID, and a link in extension options confirm the server copy. If Docker or the website is stopped, restart it and click **Sync now**. Waiting captures retry automatically. Failed captures remain available for retry or explicit discard. Never uninstall the extension before syncing pending captures: uninstalling removes extension storage.

The extension's own settings page shows the latest 100 confirmed captures, pending captures, warnings, possible duplicates, and errors. Clearing local confirmed history does not delete an application. Raw HTML is not sent to your installation. The API key is stored only in trusted extension contexts; page scripts and content scripts do not receive it.

## Jobright Queue all

Visit `https://jobright.ai/jobs/liked`. The **Reactive Resume** panel offers **Queue all**, **Resume**, and **Pause**. Keep that tab open while collecting. The extension discovers distinct posting links while scrolling the liked list and clicking explicit Load more controls, then fetches discovered pages with your existing Jobright session at roughly one per second. Uploads use batches of at most 20.

Discovery is bounded. A virtualized or changed Jobright interface can hide undiscovered items. Unless an explicit end marker is observed, the panel reports that the end was unverified; it does not claim that every liked job was found. Confirm discovered counts against your list. Pages that redirect to login, omit descriptions from fetched HTML, or fail to load are retained as jobs needing details. Repair their descriptions in Applications → Queue. You can open a posting and capture its rendered page to collect better text; duplicate captures never change existing applications. Extension options retain the full text for needs-details captures and offer **Copy captured description** for pasting into the existing application's queue details.

Bulk progress and per-URL errors survive tab reload and worker shutdown. Open the Liked page and click **Resume**. Captured locally means retained for upload; check extension options for confirmed server IDs. The extension cannot continue reading a tab that has closed or navigated away.

## Use the queue from Claude's website

The extension saves jobs; resume writing starts when you ask Claude to process the queue. Claude's web connector runs remotely, so it needs a public HTTPS address for your installation. A tunnel can provide that address while Docker runs locally. Set the installation's `APP_URL` in `.env` to that public origin and recreate the app container so OAuth discovery and PDF links use the reachable address. Open that address and sign in with your existing local account.

In Claude's **Customize → Connectors**, add a custom web connector with your public address followed by `/mcp`. Use OAuth sign-in and **Register automatically** when the OAuth client choice is shown; leave manually entered client ID and secret blank. Sign in to your Reactive Resume installation and approve access. This server supports dynamic client registration. The extension's capture-only key cannot read or edit resumes and is not a Claude credential. If using API-key request headers instead of OAuth, that Claude option is currently a limited beta and requires a separate read/write key.

Enable the connector in a Claude chat and first ask it to list your resumes and queue without changing anything. Then use **Copy Claude prompt** in Applications → Queue, or ask Claude to process the queue using your master resume. Keep Docker and the tunnel running while Claude works. The extension and a localhost browser tab do not need to remain open once captures have synced. A temporary tunnel address changes when restarted; update both `APP_URL` and the connector URL when it changes.

## Verify and package

From the repository root, run the dependency-free logic tests:

```sh
node --experimental-vm-modules --test apps/extension/tests/*.test.*js
```

Real DOM fixtures have a browser runner. Serve this folder and open `http://localhost:8765/tests/extractor-browser.html` in Chrome:

```sh
cd apps/extension
python3 -m http.server 8765 --bind 127.0.0.1
```

To create a reproducible ZIP with only installable extension files:

```sh
python3 apps/extension/scripts/package.py
```

Extract `apps/extension/dist/reactive-resume-capture.zip`, then load that extracted folder unpacked. No Chrome Web Store publication is required. Firefox and mobile are outside this extension's scope.

Manual end-to-end check: Test connection → capture a real posting → confirm its application ID in extension options and Applications → capture again and verify duplicate result → stop the website, capture another job, restart, and confirm sync → capture a small Jobright liked list and inspect every incomplete/error row. These checks require your local installation and signed-in browser and cannot be replaced by fixture tests.

