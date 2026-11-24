(function () {
    'use strict';

    const freshMs = 120000, maxAgeMs = 900000;
    const pending = new Map();

    // Store only fields allowed in the public menus, never a direct Google response.
    function publicMenu(kind, data) {
        if (kind === 'catalog' && Array.isArray(data) && data.every(row => row &&
            ['grade', 'subject', 'set'].every(key => typeof row[key] === 'string') && !('password' in row))) {
            return data.map(row => ({ grade: row.grade, subject: row.subject, set: row.set,
                learningType: String(row.learningType || ''),
                ...(row.supportsPassageStart === true ? { supportsPassageStart: true } : {}),
                ...(row.supportsQuizStart === true ? { supportsQuizStart: true } : {}) }));
        }
        if (kind === 'voca' && data && data.mode === 'days' && Array.isArray(data.days) &&
            data.days.every(row => row && typeof row.day === 'string' && Number.isInteger(row.count) && row.count >= 0)) {
            return { mode: 'days', version: 2, days: data.days.map(row => ({ day: row.day, count: row.count })) };
        }
        throw new Error('Invalid public menu');
    }

    function refresh(url, kind, key) {
        if (pending.has(key)) return pending.get(key);
        const task = (async () => {
            const controller = typeof AbortController === 'function' ? new AbortController() : null;
            let timer;
            try {
                const request = fetch(url, { cache: 'no-store', ...(controller ? { signal: controller.signal } : {}) })
                    .then(async res => {
                        if (!res.ok) {
                            const error = new Error('List service unavailable');
                            if (res.status === 503 && res.headers.get('Retry-After')) error.name = 'RetryLater';
                            throw error;
                        }
                        const entry = await res.json();
                        if (!entry || entry.version !== 1 || entry.kind !== kind) throw new Error('Invalid response');
                        const data = publicMenu(kind, entry.data);
                        const now = Date.now();
                        const fetchedAt = Number.isFinite(entry.fetchedAt) ? Math.min(now, entry.fetchedAt) : now;
                        try { sessionStorage.setItem(key, JSON.stringify({ fetchedAt, checkedAt: now, data })); } catch (_) {}
                        return data;
                    });
                const timeout = new Promise((_, reject) => {
                    timer = setTimeout(() => {
                        const error = new Error('List service timed out');
                        error.name = 'TimeoutError';
                        reject(error);
                        if (controller) controller.abort();
                    }, 28000);
                });
                return await Promise.race([request, timeout]);
            } finally { clearTimeout(timer); }
        })().finally(() => pending.delete(key));
        pending.set(key, task);
        return task;
    }

    window.StudyLists = {
        async get(source, options) {
            if (new URLSearchParams(location.search).get('studyCache') === 'off') {
                return StudyData.get(source, { ...options, force: true, noStore: true });
            }
            const original = new URL(source, location.href);
            const action = original.searchParams.get('action');
            const kind = !action ? 'catalog'
                : action === 'getVoca' && original.searchParams.get('view') === 'days' ? 'voca' : '';
            if (!kind) return StudyData.get(source, options);
            const url = new URL('/api/study-list', location.href);
            url.searchParams.set('kind', kind);
            if (kind === 'voca') url.searchParams.set('subject', original.searchParams.get('subject') || '');
            const key = 'dsskyPublicMenu_v1:' + url.search;
            try {
                const entry = JSON.parse(sessionStorage.getItem(key));
                const age = entry ? Date.now() - entry.fetchedAt : Infinity;
                if (age >= 0 && age < maxAgeMs) {
                    const data = publicMenu(kind, entry.data);
                    if (options.validate(data)) {
                        if (age >= freshMs && Date.now() - entry.checkedAt >= 10000) {
                            refresh(url.href, kind, key).catch(() => {});
                        }
                        return data;
                    }
                }
            } catch (_) { /* Storage is optional. */ }

            const deadline = Date.now() + 30000;
            const waiting = options.onWaiting ? setTimeout(options.onWaiting, 8000) : null;
            try {
                const data = await refresh(url.href, kind, key);
                if (!options.validate(data)) throw new Error('Invalid list');
                return data;
            } catch (error) {
                // A slow in-flight Google request must not start a second one from the browser.
                if (error.name === 'TimeoutError' || error.name === 'RetryLater' || Date.now() >= deadline) throw error;
                return await StudyData.get(source, { ...options, noStore: kind === 'catalog', onWaiting: undefined,
                    timeoutMs: Math.max(1, deadline - Date.now()) });
            } finally { clearTimeout(waiting); }
        }
    };
}());
