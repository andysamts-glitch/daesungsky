const upstream = 'https://script.google.com/macros/s/AKfycbxLRohgJOLdKADjTIj_BVPrKtZb2LuQCK_qOQjkqfJFSmvEWgjKIqyFkphxbkAopSWyVw/exec';
const subjects = new Set(['토플', '토익', 'SAT', '교과서', '교과서_중등', '교과서_고등']);
const freshMs = 120000;
const retainedMs = 900000;

export function sanitizeList(kind, input) {
    if (kind === 'catalog') {
        if (!Array.isArray(input) || input.length > 10000) throw new Error('Invalid catalog');
        return input.map(row => {
            if (!row || !['grade', 'subject', 'set'].every(key => typeof row[key] === 'string' && row[key].trim())) {
                throw new Error('Invalid catalog row');
            }
            // Never copy passwords, student records, or unexpected upstream fields.
            return { grade: row.grade, subject: row.subject, set: row.set,
                learningType: String(row.learningType || '') };
        });
    }
    let days;
    if (Array.isArray(input)) {
        const counts = new Map();
        for (const row of input) {
            if (!row || !['string', 'number'].includes(typeof row.day)) throw new Error('Invalid day');
            const day = String(row.day);
            counts.set(day, (counts.get(day) || 0) + 1);
        }
        days = Array.from(counts, ([day, count]) => ({ day, count }));
    } else if (input && input.mode === 'days' && Array.isArray(input.days)) {
        days = input.days;
    } else {
        throw new Error('Invalid vocabulary list');
    }
    if (days.length > 10000) throw new Error('Invalid vocabulary list');
    return { mode: 'days', version: 2, days: days.map(row => {
        if (!row || !['string', 'number'].includes(typeof row.day) || !String(row.day).trim() ||
            !Number.isInteger(row.count) || row.count < 0) throw new Error('Invalid day');
        return { day: String(row.day), count: row.count };
    }) };
}

async function bounded(promise, milliseconds) {
    let timer;
    try {
        return await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Timeout')), milliseconds);
        })]);
    } finally {
        clearTimeout(timer);
    }
}

export function createListHandler({ cache, waitUntil = () => {}, fetchImpl = fetch, now = Date.now,
    upstreamTimeoutMs = 24000, cacheTimeoutMs = 750 } = {}) {
    const memory = new Map();
    const pending = new Map();
    const retryAfter = new Map();

    function isUsable(entry, kind) {
        return entry && entry.version === 1 && entry.kind === kind && Number.isFinite(entry.fetchedAt) &&
            entry.fetchedAt <= now() && now() - entry.fetchedAt < retainedMs;
    }

    async function read(key, kind) {
        let entry = memory.get(key);
        if (!isUsable(entry, kind) || now() - entry.fetchedAt >= freshMs) {
            try {
                const shared = await bounded(Promise.resolve().then(() => cache?.get(key)), cacheTimeoutMs);
                if (isUsable(shared, kind) && (!entry || shared.fetchedAt > entry.fetchedAt)) entry = shared;
            } catch (_) {
                // Cache failure must not prevent access to the original data source.
            }
        }
        if (!isUsable(entry, kind)) return null;
        try {
            entry = { version: 1, kind, fetchedAt: entry.fetchedAt, data: sanitizeList(kind, entry.data) };
            memory.set(key, entry);
            return entry;
        } catch (_) {
            memory.delete(key);
            return null;
        }
    }

    function refresh(key, kind, subject) {
        if (pending.has(key)) return pending.get(key);
        const task = (async () => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), upstreamTimeoutMs);
            try {
                const url = new URL(upstream);
                if (kind === 'voca') {
                    url.searchParams.set('action', 'getVoca');
                    url.searchParams.set('subject', subject);
                    url.searchParams.set('view', 'days');
                }
                url.searchParams.set('t', now());
                const response = await fetchImpl(url.href, { signal: controller.signal, cache: 'no-store' });
                if (!response.ok) throw new Error('Upstream response failed');
                const data = sanitizeList(kind, await response.json());
                const entry = { version: 1, kind, fetchedAt: now(), data };
                memory.set(key, entry);
                retryAfter.delete(key);
                try {
                    await bounded(Promise.resolve().then(() => cache?.set(key, entry, { ttl: retainedMs / 1000 })), cacheTimeoutMs);
                } catch (_) {
                    // The small per-instance copy still works if shared storage is unavailable.
                }
                return entry;
            } catch (error) {
                retryAfter.set(key, now() + 30000);
                throw error;
            } finally {
                clearTimeout(timer);
            }
        })().finally(() => pending.delete(key));
        pending.set(key, task);
        return task;
    }

    return async function handler(req, res) {
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        const send = (status, data) => {
            res.statusCode = status;
            res.end(JSON.stringify(data));
        };
        if (req.method !== 'GET') {
            res.setHeader('Allow', 'GET');
            return send(405, { error: 'Method not allowed' });
        }
        if (process.env.STUDY_LIST_CACHE_DISABLED === '1') return send(503, { error: 'Pilot disabled' });
        const url = new URL(req.url, 'https://www.dssky.co.kr');
        const kind = url.searchParams.get('kind');
        const subject = url.searchParams.get('subject') || '';
        if ([...url.searchParams.keys()].some(key => !['kind', 'subject'].includes(key)) ||
            url.searchParams.getAll('kind').length !== 1 || url.searchParams.getAll('subject').length > 1 ||
            !['catalog', 'voca'].includes(kind) || (kind === 'catalog' ? subject !== '' : !subjects.has(subject))) {
            return send(400, { error: 'Invalid list request' });
        }
        // Fixed endpoints and seven bounded keys: this cannot proxy arbitrary URLs or actions.
        const key = `dssky-study-list-v1:${kind}:${subject}`;
        try {
            const entry = await read(key, kind);
            if (entry) {
                const stale = now() - entry.fetchedAt >= freshMs;
                if (stale && (retryAfter.get(key) || 0) <= now()) {
                    waitUntil(refresh(key, kind, subject).catch(() => {}));
                }
                res.setHeader('X-Study-List-Cache', stale ? 'STALE' : 'HIT');
                return send(200, entry);
            }
            if ((retryAfter.get(key) || 0) > now()) return send(503, { error: 'List temporarily unavailable' });
            const fresh = await refresh(key, kind, subject);
            res.setHeader('X-Study-List-Cache', 'MISS');
            return send(200, fresh);
        } catch (_) {
            // Do not expose upstream bodies, redirect tokens, or spreadsheet contents in errors.
            return send(503, { error: 'List temporarily unavailable' });
        }
    };
}
