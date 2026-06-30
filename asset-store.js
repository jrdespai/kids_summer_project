/**
 * IndexedDB persistence for custom sprites and sounds.
 * Shared by the main game and Asset Studio.
 */
(() => {
    const DB_NAME = 'antigravity-assets';
    const DB_VERSION = 2;
    const SPRITE_STORE = 'sprites';
    const SOUND_STORE = 'sounds';
    const STATS_STORE = 'stats';

    let dbPromise = null;

    function openDb() {
        if (dbPromise) return dbPromise;

        dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(SPRITE_STORE)) {
                    db.createObjectStore(SPRITE_STORE);
                }
                if (!db.objectStoreNames.contains(SOUND_STORE)) {
                    db.createObjectStore(SOUND_STORE);
                }
                if (!db.objectStoreNames.contains(STATS_STORE)) {
                    db.createObjectStore(STATS_STORE);
                }
            };

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });

        return dbPromise;
    }

    function storeGet(storeName, key) {
        return openDb().then((db) => new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, 'readonly');
            const store = tx.objectStore(storeName);
            const request = store.get(String(key));

            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error);
        }));
    }

    function storePut(storeName, key, value) {
        return openDb().then((db) => new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, 'readwrite');
            const store = tx.objectStore(storeName);
            const request = store.put(value, String(key));

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        }));
    }

    function storeDelete(storeName, key) {
        return openDb().then((db) => new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, 'readwrite');
            const store = tx.objectStore(storeName);
            const request = store.delete(String(key));

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        }));
    }

    function storeGetAll(storeName) {
        return openDb().then((db) => new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, 'readonly');
            const store = tx.objectStore(storeName);
            const request = store.getAll();
            const keysRequest = store.getAllKeys();

            Promise.all([
                new Promise((res, rej) => {
                    request.onsuccess = () => res(request.result);
                    request.onerror = () => rej(request.error);
                }),
                new Promise((res, rej) => {
                    keysRequest.onsuccess = () => res(keysRequest.result);
                    keysRequest.onerror = () => rej(keysRequest.error);
                })
            ]).then(([values, keys]) => {
                const entries = keys.map((key, i) => [key, values[i]]);
                resolve(entries);
            }).catch(reject);
        }));
    }

    const objectUrls = new Set();

    window.AssetStore = {
        getSprite(tier) {
            return storeGet(SPRITE_STORE, tier);
        },

        putSprite(tier, blob) {
            return storePut(SPRITE_STORE, tier, {
                blob,
                updatedAt: Date.now()
            });
        },

        deleteSprite(tier) {
            return storeDelete(SPRITE_STORE, tier);
        },

        getSound(name) {
            return storeGet(SOUND_STORE, name);
        },

        putSound(name, blob) {
            return storePut(SOUND_STORE, name, {
                blob,
                updatedAt: Date.now()
            });
        },

        deleteSound(name) {
            return storeDelete(SOUND_STORE, name);
        },

        async getAllOverrides() {
            const [spriteEntries, soundEntries] = await Promise.all([
                storeGetAll(SPRITE_STORE),
                storeGetAll(SOUND_STORE)
            ]);

            return {
                sprites: spriteEntries.map(([key, record]) => ({
                    tier: Number(key),
                    blob: record.blob,
                    updatedAt: record.updatedAt
                })),
                sounds: soundEntries.map(([key, record]) => ({
                    name: key,
                    blob: record.blob,
                    updatedAt: record.updatedAt
                }))
            };
        },

        createObjectUrl(blob) {
            const url = URL.createObjectURL(blob);
            objectUrls.add(url);
            return url;
        },

        revokeObjectUrl(url) {
            if (objectUrls.has(url)) {
                URL.revokeObjectURL(url);
                objectUrls.delete(url);
            }
        },

        revokeAllObjectUrls() {
            objectUrls.forEach((url) => URL.revokeObjectURL(url));
            objectUrls.clear();
        },

        getGameStats() {
            return storeGet(STATS_STORE, 'profile').then((record) => {
                if (!record) {
                    return {
                        classicBest: 0,
                        expertBest: 0,
                        totalGames: 0,
                        expertMode: false,
                        bestTierReached: 0,
                        milestones: {
                            first_star: false,
                            first_nebula: false
                        }
                    };
                }
                return record;
            });
        },

        saveGameStats(stats) {
            return storePut(STATS_STORE, 'profile', stats);
        }
    };
})();
