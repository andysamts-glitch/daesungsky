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
        const budget = Number.isFinite(options.timeoutMs) ? Math.max(1, Math.min(options.timeoutMs, 30000)) : 30000;
        const deadline = Date.now() + budget;
        function timeoutError() {
            const error = new Error('Data request timed out');
            error.name = 'TimeoutError';
            return error;
        }
        for (let attempt = 1; attempt <= attempts; attempt++) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) throw timeoutError();
            const controller = typeof AbortController === 'function' ? new AbortController() : null;
            let timer;
            let waitingTimer;
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
                        reject(timeoutError());
                        if (controller) controller.abort();
                    }, remaining);
                });
                if (options.onWaiting) waitingTimer = setTimeout(options.onWaiting, 8000);
                const data = await Promise.race([request, timeout]);
                if (!options.validate(data)) throw new Error('Invalid study data');
                const json = JSON.stringify(data);
                remember(key, json);
                return json;
            } catch (error) {
                // A slow successful response must not be restarted at the old 15-second cutoff.
                if (attempt === attempts || error.name === 'TimeoutError' || Date.now() >= deadline) throw error;
            } finally {
                clearTimeout(timer);
                clearTimeout(waitingTimer);
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
