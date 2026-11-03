import test from 'node:test';
import assert from 'node:assert/strict';
import {
    cleanWord,
    cleanText,
    chooseTarget,
    dictionaryCacheKey,
    newReviewState,
    scheduleReview,
    normalizeDictionary,
    completedJsonFields,
    relativeSelection,
} from '../src/hover/core.js';

test('cleans OCR punctuation without excluding non-English words', () => {
    assert.equal(cleanWord(' “emergent,” '), 'emergent');
    assert.equal(cleanWord('l’esprit'), "l'esprit");
    assert.equal(cleanWord('compreensível'), 'compreensível');
    assert.equal(cleanWord('读懂'), '读懂');
    assert.equal(cleanWord('I'), 'I');
    for (const value of ['', '***', '1234', 'bad\ufffdword', 'two words', 'ab##cd'])
        assert.equal(cleanWord(value), null);
    assert.equal(cleanText('a\u200b\n b'), 'a b');
});

test('symbols next to a term resolve to that term instead of doing nothing', () => {
    const words = [
        { text: 'Zc', rect: { x: 0, y: 10, width: 20, height: 12 }, line: 0 },
        { text: '(', rect: { x: 24, y: 10, width: 5, height: 12 }, line: 0 },
        { text: '4430', rect: { x: 31, y: 10, width: 30, height: 12 }, line: 0 },
        { text: ')', rect: { x: 62, y: 10, width: 5, height: 12 }, line: 0 },
    ];
    // Clicking the bracket used to return nothing, so the page felt unresponsive.
    assert.equal(chooseTarget(words, { x: 26, y: 16 }).word, 'Zc');
    // A typographic minus keeps a Greek compound in one lookup term.
    assert.equal(cleanWord('π−p'), 'π-p');
    assert.equal(cleanWord('P–wave'), 'P-wave');
});

test('selects the word under the pointer, transforms monitor origin and retains context', () => {
    const words = [
        { text: 'An', rect: { x: 0, y: 10, width: 15, height: 12 }, line: 0 },
        { text: 'example', rect: { x: 20, y: 10, width: 50, height: 12 }, line: 0 },
    ];
    const result = chooseTarget(words, { x: -960, y: 115 }, { x: -1000, y: 100 });
    assert.equal(result.word, 'example');
    assert.equal(result.context, 'An example');
    assert.equal(result.rect.x, -980);
    assert.equal(chooseTarget(words, { x: 400, y: 400 }), null);
    assert.equal(chooseTarget([{ text: '#%', rect: words[0].rect }], { x: 5, y: 15 }), null);
});

test('cache keys preserve case and distinguish meaning, model, provider and prompt version', () => {
    const query = { word: 'US', context: 'in the US', from: 'en', to: 'zh_cn', provider: 'deepseek@1', model: 'flash' };
    const key = dictionaryCacheKey(query);
    assert.equal(key, dictionaryCacheKey({ ...query, context: ' in   the US ' }));
    for (const change of [
        { word: 'us' },
        { context: 'help us' },
        { provider: 'deepl' },
        { model: 'pro' },
        { promptVersion: 2 },
        { to: 'ja' },
        { endpoint: 'https://example.invalid' },
    ]) {
        assert.notEqual(key, dictionaryCacheKey({ ...query, ...change }));
    }
});

test('cache keys do not persist credentials from a custom endpoint URL', () => {
    const key = dictionaryCacheKey({ word:'word', context:'context', to:'zh_cn', provider:'custom', endpoint:'https://account:secret@example.com/v1?api_key=token' });
    assert.ok(!key.includes('secret') && !key.includes('token') && !key.includes('account'));
    assert.ok(key.includes('example.com/v1'));
});

test('drag coordinates clip to the original monitor including negative screen origins', () => {
    assert.deepEqual(
        relativeSelection({ x: -1900, y: 100 }, { x: -1800, y: 150 }, { x: -1920, y: 0, width: 1920, height: 1080 }),
        { left: 20, top: 100, width: 100, height: 50 }
    );
    assert.equal(relativeSelection({ x: 0, y: 10 }, { x: 0, y: 20 }, { x: 0, y: 0, width: 100, height: 100 }), null);
});

test('SM2 uses 1, 6 and 15 days for repeated quality 4 and persists ease', () => {
    const now = new Date('2026-11-02T12:00:00+08:00').getTime();
    let state = newReviewState();
    for (const interval of [1, 6, 15, 38]) {
        state = scheduleReview(state, 4, now);
        assert.equal(state.intervalDays, interval);
        assert.equal(state.easeFactor, 2.5);
    }
    assert.equal(state.repetitions, 4);
});

test('SM2 failure resets repetitions and ease cannot fall below 1.3', () => {
    let state = { ...newReviewState(), repetitions: 8, intervalDays: 100 };
    for (let index = 0; index < 5; index++) state = scheduleReview(state, 0, Date.now());
    assert.equal(state.repetitions, 0);
    assert.equal(state.intervalDays, 1);
    assert.equal(state.easeFactor, 1.3);
    assert.equal(state.lapses, 5);
    assert.equal(scheduleReview(state, 4).repetitions, 1);
    assert.throws(() => scheduleReview(state, 6), RangeError);
    assert.throws(() => scheduleReview(state, 1.5), RangeError);
});

test('ordinary API results normalize without fabricated dictionary fields', () => {
    const query = { word: 'example', context: 'An example', from: 'en', to: 'zh_cn', provider: 'deepl' };
    const result = normalizeDictionary('示例', query);
    assert.deepEqual(result.phonetics, []);
    assert.deepEqual(result.examples, []);
    assert.equal(result.senses[0].definition, '示例');
    assert.equal(result.word, query.word);
    assert.throws(() => normalizeDictionary({ word: 'invented' }, query), /definition/);
    assert.throws(() => normalizeDictionary('   ', query), /definition/);
});

test('stream snapshots expose only completed JSON fields, including escaped and nested values', () => {
    const text = '```json\n{"word":"a\\"b","phonetics":[],"senses":[{"definition":"示例"}],"contextTranslation":"半';
    const result = completedJsonFields(text);
    assert.deepEqual(result, { word: 'a"b', phonetics: [], senses: [{ definition: '示例' }] });
    assert.deepEqual(completedJsonFields('{"word":"incomplete'), {});
    assert.deepEqual(completedJsonFields('{"a":null,"b":false,"c":4}'), { a: null, b: false, c: 4 });
    assert.equal(Object.getPrototypeOf(completedJsonFields('{"__proto__":{"bad":true}}')), Object.prototype);
    assert.equal({}.bad, undefined);
});
