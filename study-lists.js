(function () {
    'use strict';

    window.StudyLists = {
        async get(source, options) {
            if (new URLSearchParams(location.search).get('studyCache') === 'off') {
                return StudyData.get(source, { ...options, force: true });
            }
            const original = new URL(source, location.href);
            const action = original.searchParams.get('action');
            const kind = !action ? 'catalog'
                : action === 'getVoca' && original.searchParams.get('view') === 'days' ? 'voca' : '';
            if (!kind) return StudyData.get(source, options);
            const url = new URL('/api/study-list', location.href);
            url.searchParams.set('kind', kind);
            if (kind === 'voca') url.searchParams.set('subject', original.searchParams.get('subject') || '');

            const deadline = Date.now() + 30000;
            const controller = typeof AbortController === 'function' ? new AbortController() : null;
            let timer;
            const waitingTimer = options.onWaiting ? setTimeout(options.onWaiting, 8000) : null;
            try {
                try {
                    const request = fetch(url.href, {
                        cache: 'no-store',
                        ...(controller ? { signal: controller.signal } : {})
                    }).then(async response => {
                        if (!response.ok) throw new Error('List service unavailable');
                        const result = await response.json();
                        if (!result || result.version !== 1 || result.kind !== kind || !options.validate(result.data)) {
                            throw new Error('Invalid list response');
                        }
                        if (kind === 'catalog' && !result.data.every(row => row &&
                            ['grade', 'subject', 'set'].every(key => typeof row[key] === 'string') &&
                            !Object.prototype.hasOwnProperty.call(row, 'password'))) throw new Error('Invalid catalog');
                        return result.data;
                    });
                    const timeout = new Promise((_, reject) => {
                        timer = setTimeout(() => {
                            reject(new Error('List service timed out'));
                            if (controller) controller.abort();
                        }, 6000);
                    });
                    return await Promise.race([request, timeout]);
                } catch (_) {
                    // Static/local previews and server failures retain the original Google path.
                    clearTimeout(timer);
                    return await StudyData.get(source, { ...options, onWaiting: undefined,
                        timeoutMs: Math.max(1, deadline - Date.now()) });
                }
            } finally {
                clearTimeout(timer);
                clearTimeout(waitingTimer);
            }
        }
    };
}());
