import { dictionaryCacheKey } from './core.js';
import { friendlyError } from './settings.js';

// Dependencies are supplied by the Pot adapter, so cancellation/cache/fallback
// behavior can be tested without real credentials or a desktop window.
export function createLookup({ prepare, request, readCache, writeCache }) {
    const pending = new Map();
    return async function lookup(target, settings, options = {}) {
        const sources = [...new Set([options.provider || settings.provider, ...settings.fallbackProviders])].filter(
            Boolean
        );
        const failures = [];
        let cacheWarning = '';
        for (const provider of sources) {
            if (options.signal?.aborted) throw new Error('Cancelled');
            options.onProvider?.(provider, failures.slice());
            try {
                const { query, config } = await prepare(provider, target, settings);
                let cached;
                try {
                    cached = !options.force && (await readCache(query));
                } catch {
                    // A broken or busy cache must never block a lookup: retry once,
                    // then go straight to the network with a warning.
                    await new Promise((resolve) => setTimeout(resolve, 250));
                    try {
                        cached = !options.force && (await readCache(query));
                    } catch {
                        cacheWarning = '本地缓存暂时不可用，本次直接查询';
                        cached = null;
                    }
                }
                if (options.signal?.aborted) throw new Error('Cancelled');
                if (cached) return cached;
                const key = dictionaryCacheKey(query);
                let entry = pending.get(key);
                if (!entry || entry.signal?.aborted || entry.sessionId !== options.sessionId || options.force) {
                    entry = { signal: options.signal, sessionId: options.sessionId };
                    entry.promise = request(query, config, { ...options, timeoutMs: settings.timeoutMs })
                        .then(async (result) => {
                            if (options.signal?.aborted) throw new Error('Cancelled');
                            try {
                                await writeCache(query, result);
                            } catch {
                                result = { ...result, cacheWarning: '本次结果未能写入缓存' };
                            }
                            return result;
                        })
                        .finally(() => {
                            if (pending.get(key) === entry) pending.delete(key);
                        });
                    pending.set(key, entry);
                }
                const result = await entry.promise;
                if (options.signal?.aborted) throw new Error('Cancelled');
                const warning = cacheWarning || result.cacheWarning;
                return warning ? { ...result, cacheWarning: warning } : result;
            } catch (error) {
                if (options.signal?.aborted || /cancel/iu.test(String(error))) throw new Error('Cancelled');
                if (error.terminal) throw error;
                failures.push(`${provider}：${friendlyError(error)}`);
            }
        }
        throw new Error(failures.join('\n') || '没有可用翻译服务，请先配置服务');
    };
}
