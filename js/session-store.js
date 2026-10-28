// ============================================
// SESSION STORE - AudioLoft
// ============================================
//
// Keeps Studio sessions in IndexedDB, in this browser only. Two stores:
//
//   sessions – one small record per session: name, dates, lanes, clips and
//              view settings. Rewritten on every autosave.
//   sources  – the audio behind a session, keyed "<sessionId>/<sourceId>".
//              Files are kept as the original (compressed) bytes and decoded
//              again on open; the demo layers are kept as a recipe and
//              re-synthesised. Written once per source.
//
// Nothing here leaves the device.

(function (global) {
    'use strict';

    const AL = global.AudioLoft;

    const DB_NAME = 'audioloft';
    const DB_VERSION = 1;

    let opening = null;

    function open() {
        if (!opening) {
            opening = new Promise((resolve, reject) => {
                if (!global.indexedDB) {
                    reject(new Error('This browser has no IndexedDB.'));
                    return;
                }
                const request = global.indexedDB.open(DB_NAME, DB_VERSION);
                request.onupgradeneeded = () => {
                    const db = request.result;
                    if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
                    if (!db.objectStoreNames.contains('sources')) db.createObjectStore('sources', { keyPath: 'key' });
                };
                request.onsuccess = () => {
                    const db = request.result;
                    // Another tab upgrading the database needs this one to let go.
                    db.onversionchange = () => {
                        db.close();
                        opening = null;
                    };
                    resolve(db);
                };
                request.onerror = () => reject(request.error);
                request.onblocked = () => reject(new Error('Saved sessions are busy in another tab.'));
            });
            opening.catch(() => { opening = null; });
        }
        return opening;
    }

    // Runs `work(stores)` in one transaction and resolves when it commits.
    async function run(names, mode, work) {
        const db = await open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(names, mode);
            const stores = Object.fromEntries(names.map((name) => [name, tx.objectStore(name)]));
            let result;
            tx.oncomplete = () => resolve(result);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('Saving was interrupted.'));
            result = work(stores);
        });
    }

    const request = (req) => new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });

    const sourceKey = (sessionId, sourceId) => `${sessionId}/${sourceId}`;
    const sourceRange = (sessionId) => IDBKeyRange.bound(`${sessionId}/`, `${sessionId}/￿`);

    // Newest first.
    async function list() {
        let all = [];
        await run(['sessions'], 'readonly', ({ sessions }) => {
            request(sessions.getAll()).then((value) => { all = value; });
        });
        return all.sort((a, b) => b.updatedAt - a.updatedAt);
    }

    async function load(id) {
        let record;
        let sources;
        await run(['sessions', 'sources'], 'readonly', (stores) => {
            request(stores.sessions.get(id)).then((value) => { record = value; });
            request(stores.sources.getAll(sourceRange(id))).then((value) => { sources = value; });
        });
        if (!record) throw new Error('That session is no longer saved in this browser.');
        return { record, sources: sources || [] };
    }

    function saveRecord(record) {
        return run(['sessions'], 'readwrite', ({ sessions }) => { sessions.put(record); });
    }

    // `data` is { name, size, blob } for a file or { name, size, recipe } for
    // generated audio.
    function saveSource(sessionId, sourceId, data) {
        return run(['sources'], 'readwrite', ({ sources }) => {
            sources.put(Object.assign({ key: sourceKey(sessionId, sourceId), sessionId, id: sourceId }, data));
        });
    }

    // Drops stored sources that no clip uses any more.
    function pruneSources(sessionId, keepIds) {
        const keep = new Set(keepIds.map((id) => sourceKey(sessionId, id)));
        return run(['sources'], 'readwrite', ({ sources }) => {
            const cursor = sources.openKeyCursor(sourceRange(sessionId));
            cursor.onsuccess = () => {
                const c = cursor.result;
                if (!c) return;
                if (!keep.has(c.primaryKey)) sources.delete(c.primaryKey);
                c.continue();
            };
        });
    }

    function remove(id) {
        return run(['sessions', 'sources'], 'readwrite', (stores) => {
            stores.sessions.delete(id);
            stores.sources.delete(sourceRange(id));
        });
    }

    function newId() {
        if (global.crypto && crypto.randomUUID) return crypto.randomUUID();
        return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    }

    // Quota errors come under a few names depending on the browser.
    function isQuotaError(error) {
        return !!error && (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED' || error.code === 22);
    }

    AL.sessionStore = {
        open,
        list,
        load,
        saveRecord,
        saveSource,
        pruneSources,
        remove,
        newId,
        isQuotaError
    };
})(window);
