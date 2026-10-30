const DATABASE = "reactive-resume-autofill-drafts";
const STORE = "drafts";
const MAX_AGE = 24 * 60 * 60 * 1000;

function openDatabase() {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DATABASE, 1);
		request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "key" });
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

function transaction(database, mode, operation) {
	return new Promise((resolve, reject) => {
		const current = database.transaction(STORE, mode);
		let result;
		current.oncomplete = () => resolve(result);
		current.onabort = () => reject(current.error || new Error("The application draft could not be saved."));
		operation(current.objectStore(STORE), (value) => { result = value; });
	});
}

function prune(database, shouldDelete) {
	return transaction(database, "readwrite", (store) => {
		const request = store.openCursor();
		request.onsuccess = () => {
			const cursor = request.result;
			if (!cursor) return;
			if (shouldDelete(cursor.value)) cursor.delete();
			cursor.continue();
		};
	});
}

export async function openAutofillDraftStore({ sessionId, tabId, tabUrl }) {
	if (!sessionId || !Number.isInteger(tabId) || !/^https?:\/\//.test(tabUrl || "")) {
		throw new Error("Open the employer’s application form before preparing autofill.");
	}
	const database = await openDatabase();
	database.onversionchange = () => database.close();
	// File objects use IndexedDB's structured clone, avoiding the 10 MB session-storage
	// quota and base64 expansion. Old browser sessions cannot restore another PDF.
	await prune(database, (item) => item.sessionId !== sessionId || Date.now() - item.updatedAt > MAX_AGE);
	const key = JSON.stringify([sessionId, tabId, tabUrl]);
	return {
		read: () => transaction(database, "readonly", (store, result) => {
			const request = store.get(key);
			request.onsuccess = () => result(request.result?.draft || null);
		}),
		// Start the transaction synchronously on every input event. Do not debounce or
		// wait for blur/unload: Chrome destroys the popup when focus leaves it.
		write: (draft) => transaction(database, "readwrite", (store) => {
			store.put({ key, sessionId, tabId, tabUrl, updatedAt: Date.now(), draft });
		}),
		clear: () => transaction(database, "readwrite", (store) => store.delete(key)),
	};
}

export async function deleteAutofillTabDrafts(tabId) {
	const database = await openDatabase();
	try { await prune(database, (item) => item.tabId === tabId); }
	finally { database.close(); }
}

export async function pruneAutofillDrafts(sessionId) {
	const database = await openDatabase();
	try { await prune(database, (item) => item.sessionId !== sessionId || Date.now() - item.updatedAt > MAX_AGE); }
	finally { database.close(); }
}
