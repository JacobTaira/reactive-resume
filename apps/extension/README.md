# Reactive Resume Capture Queue

Manifest V3 Chrome extension for your own Reactive Resume installation. Capture uses deterministic extraction and never calls an AI provider. It creates saved applications, never marks jobs Applied.

## Install on Windows Chrome

1. Update your fork checkout and start the local Reactive Resume website.
2. Open `chrome://extensions`, enable **Developer mode**, then click **Load unpacked**.
3. Choose this `apps/extension` folder. For an Ubuntu WSL checkout, browse to `\\wsl.localhost\Ubuntu\home\jacob\reactive-resume-latex\apps\extension`; substitute your actual distro and home directory.
4. Pin **Reactive Resume Capture Queue** to Chrome's toolbar. Open its Details → Extension options.
5. Set **Installation URL** to `http://localhost:3000`. Create a capture-only API key in Reactive Resume's API settings and enter it under **Capture-only API key**. Click **Save settings and grant access**, approve access to your installation, then **Test connection**.

No Node installation or extension build is needed to load the checked-in folder. After pulling extension changes, click Reload on its `chrome://extensions` card and reload open Jobright tabs.

## Capture a job

Open its page and click the toolbar button, or press **Ctrl+Shift+Y**. The extension reads the rendered page: matching JobPosting JSON-LD first, Jobright sections next, selected text or main page text last. The fallback needs review and can include unrelated page text. Company/role fallback values are flagged.

On Jobright, capture waits briefly for loading content, reads section bodies across nested wrappers, and uses matching posting-title/company metadata. Headings and the skills legend alone are not a description. Missing section bodies keep useful partial text under Needs details rather than allowing an unfinished capture into preparation.

The capture is saved to a durable browser outbox before upload. A waiting badge means it is retained locally; **Saved in Applications**, an application ID, and a link in extension options confirm the server copy. If Docker or the website is stopped, restart it and click **Sync now**. Waiting captures retry automatically. Failed captures remain available for retry or explicit discard. Never uninstall the extension before syncing pending captures: uninstalling removes extension storage.

The extension's own settings page shows the latest 100 confirmed captures, pending captures, warnings, possible duplicates, and errors. Clearing local confirmed history does not delete an application. Raw HTML is not sent to your installation. The API key is stored only in trusted extension contexts; page scripts and content scripts do not receive it.

## Jobright Queue all

Visit `https://jobright.ai/jobs/liked`. The **Reactive Resume** panel offers **Queue all**, **Resume**, and **Pause**. Keep that tab open while collecting. The extension discovers distinct posting links while scrolling the liked list and clicking explicit Load more controls, then fetches discovered pages with your existing Jobright session at roughly one per second. Uploads use batches of at most 20.

Discovery is bounded. A virtualized or changed Jobright interface can hide undiscovered items. Unless an explicit end marker is observed, the panel reports that the end was unverified; it does not claim that every liked job was found. Confirm discovered counts against your list. Pages that redirect to login, omit descriptions from fetched HTML, or fail to load are retained as jobs needing details. Repair their descriptions in Applications → Queue. You can open a posting and capture its rendered page to collect better text; duplicate captures never change existing applications. Extension options retain the full text for needs-details captures and offer **Copy captured description** for pasting into the existing application's queue details.

Bulk progress and per-URL errors survive tab reload and worker shutdown. Open the Liked page and click **Resume**. Captured locally means retained for upload; check extension options for confirmed server IDs. The extension cannot continue reading a tab that has closed or navigated away.

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
