import test from 'node:test';
import assert from 'node:assert/strict';
import { createLookup } from '../src/hover/lookup.js';
import { dictionaryCacheKey } from '../src/hover/core.js';
const target = { word: 'bank', context: 'the bank of the river' };
const settings = { provider: 'primary', fallbackProviders: ['backup'], targetLanguage: 'zh_cn', timeoutMs: 100 };
function harness(request) {
    const cache = new Map(),
        calls = [];
    const lookup = createLookup({
        prepare: async (provider, target, settings) => ({
            query: { ...target, provider, to: settings.targetLanguage },
            config: {},
        }),
        request: async (query, config, options) => {
            calls.push(query.provider);
            return request(query, options);
        },
        readCache: async (query) => cache.get(dictionaryCacheKey(query)),
        writeCache: async (query, result) => cache.set(dictionaryCacheKey(query), result),
    });
    return { lookup, calls };
}
test('cache avoids repeat API requests and force retranslation bypasses it', async () => {
    const { lookup, calls } = harness(async (query) => ({ provider: query.provider }));
    await lookup(target, settings);
    await lookup(target, settings);
    assert.deepEqual(calls, ['primary']);
    await lookup(target, settings, { force: true });
    assert.equal(calls.length, 2);
});
test('concurrent identical requests share one API operation', async () => {
    const { lookup, calls } = harness(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {};
    });
    await Promise.all([lookup(target, settings), lookup(target, settings)]);
    assert.equal(calls.length, 1);
});
test('authentication and timeout failures fall back in configured order', async () => {
    for (const failure of ['HTTP 401', 'Request timeout', 'HTTP 402']) {
        const { lookup, calls } = harness(async (query) => {
            if (query.provider === 'primary') throw new Error(failure);
            return { provider: query.provider };
        });
        assert.equal((await lookup(target, settings)).provider, 'backup');
        assert.deepEqual(calls, ['primary', 'backup']);
    }
});
test('release/cancellation never starts a backup and does not cache the stale answer', async () => {
    const controller = new AbortController();
    const { lookup, calls } = harness(async () => {
        controller.abort();
        throw new Error('Request timeout');
    });
    await assert.rejects(lookup(target, settings, { signal: controller.signal }), /Cancelled/);
    assert.deepEqual(calls, ['primary']);
});
test('disk write failure returns the paid result without starting another paid request', async () => {
    const calls = [];
    const lookup = createLookup({
        prepare: async (provider) => ({ query: { ...target, provider, to: 'zh_cn' } }),
        request: async (query) => {
            calls.push(query.provider);
            return { provider: query.provider };
        },
        readCache: async () => null,
        writeCache: async () => {
            throw new Error('disk full');
        },
    });
    assert.ok((await lookup(target, settings)).cacheWarning);
    assert.deepEqual(calls, ['primary']);
});
