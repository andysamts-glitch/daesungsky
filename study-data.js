(function () {
    'use strict';

    const storageKey = 'dsskyStudyData_v1';
    const ttlMs = 120000;
    const pending = new Map();
    let entries = {};
    try {
        const stored = JSON.parse(sessionStorage.getItem(storageKey) || '{}');
        if (stored && typeof stored === 'object' && !Array.isArray(stored)) entries = stored;
    } catch (error) {
        // Storage is optional, including in private browsing.
    }

    function requestKey(url) {
        const key = new URL(url, location.href);
        key.searchParams.delete('t');
        key.searchParams.sort();
        return key.href;
    }

    function remember(key, json) {
        entries[key] = { json, expires: Date.now() + ttlMs };
        const keys = Object.keys(entries).filter(item => entries[item] && entries[item].expires > Date.now())
            .sort((a, b) => entries[b].expires - entries[a].expires);
        const kept = {};
        let size = 0;
        for (const item of keys) {
            const entry = entries[item];
            if (typeof entry.json !== 'string') continue;
            size += entry.json.length;
            if (Object.keys(kept).length < 12 && size <= 750000) kept[item] = entry;
        }
        entries = kept;
        try {
            sessionStorage.setItem(storageKey, JSON.stringify(entries));
        } catch (error) {
            // Keep the in-memory copy if storage is full or blocked.
        }
    }

    async function fetchJson(key, options) {
        const attempts = 2;
        for (let attempt = 1; attempt <= attempts; attempt++) {
            const controller = typeof AbortController === 'function' ? new AbortController() : null;
            let timer;
            try {
                const url = new URL(key);
                url.searchParams.set('t', Date.now());
                const request = fetch(url.href, {
                    cache: 'no-store',
                    ...(controller ? { signal: controller.signal } : {})
                }).then(response => {
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    return response.json();
                });
                const timeout = new Promise((resolve, reject) => {
                    timer = setTimeout(() => {
                        if (controller) controller.abort();
                        reject(new Error('Data request timed out'));
                    }, 15000);
                });
                const data = await Promise.race([request, timeout]);
                if (!options.validate(data)) throw new Error('Invalid study data');
                const json = JSON.stringify(data);
                remember(key, json);
                return json;
            } catch (error) {
                if (attempt === attempts) throw error;
            } finally {
                clearTimeout(timer);
            }
            if (options.onRetry) options.onRetry(attempt + 1, attempts);
            await new Promise(resolve => setTimeout(resolve, 600 + Math.random() * 400));
        }
    }

    window.StudyData = {
        async get(url, options) {
            const key = requestKey(url);
            const entry = entries[key];
            if (!options.force && entry && entry.expires > Date.now()) {
                try {
                    const data = JSON.parse(entry.json);
                    if (options.validate(data)) return data;
                } catch (error) {
                    // A malformed entry is replaced by a network response.
                }
            }
            if (!pending.has(key)) {
                const request = fetchJson(key, options).finally(() => pending.delete(key));
                pending.set(key, request);
            }
            // Each test gets its own copy; answering must not mutate cached questions.
            const data = JSON.parse(await pending.get(key));
            if (!options.validate(data)) throw new Error('Invalid study data');
            return data;
        }
    };
}());
