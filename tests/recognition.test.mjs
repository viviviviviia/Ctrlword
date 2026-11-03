import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecognizer, contextLooksBroken } from '../src/hover/recognition.js';
import { chooseTarget, cleanWord } from '../src/hover/core.js';

const word = { text: 'observed', line: 0, rect: { x: 40, y: 40, width: 70, height: 18 } };
const frame = { words: [word], point: { x: 60, y: 65 }, captureRect: { x: 0, y: 0, width: 1280, height: 420 } };

test('one context frame handles a pointer below the word without a second OCR pass', async () => {
    const captures = [];
    let fallbackCount = 0;
    const recognize = createRecognizer({ capture: async (id, context) => { captures.push([id, context]); return frame; }, fallback: async () => { fallbackCount++; return []; } });
    const target = await recognize(9, { expandContext: true, ocrEngine: 'auto' }, new AbortController().signal);
    assert.equal(target.word, 'observed');
    assert.deepEqual(captures, [[9, true]]);
    assert.equal(fallbackCount, 0);
    assert.equal(chooseTarget([word], { x: 60, y: 85 }), null);
});

test('fallback uses the same image and system-only mode never invokes it', async () => {
    let fallbackCount = 0;
    const recognize = createRecognizer({ capture: async () => ({ ...frame, words: [] }), fallback: async (image) => { assert.equal(image.captureRect.width, 1280); fallbackCount++; return [word]; } });
    assert.equal((await recognize(1, { expandContext: true, ocrEngine: 'auto' }, new AbortController().signal)).word, 'observed');
    assert.equal(await recognize(2, { expandContext: false, ocrEngine: 'system' }, new AbortController().signal), null);
    assert.equal(fallbackCount, 1);
});

test('cancelled captures and clipped fragments do not produce a target', async () => {
    const controller = new AbortController();
    const recognize = createRecognizer({ capture: async () => { controller.abort(); return frame; }, fallback: async () => { throw new Error('must not run'); } });
    await assert.rejects(recognize(1, { expandContext: true }, controller.signal), /Cancelled/);
    const clipped = createRecognizer({ capture: async () => ({ ...frame, words: [{ ...word, rect: { ...word.rect, x: 0 } }], point: { x: 5, y: 45 } }), fallback: async () => [] });
    assert.equal(await clipped(2, { ocrEngine: 'system' }, new AbortController().signal), null);
});

test('obvious dotted OCR garbage is rejected while genuine abbreviations remain usable', () => {
    assert.equal(cleanWord('t.Ve'), null);
    assert.equal(cleanWord('U.S.'), 'U.S');
    assert.equal(cleanWord('e.g.'), 'e.g');
});

test('the slow Tesseract pass only runs for contexts that are visibly unusable', () => {
    // A formula gap makes the frame uncertain but the sentence is still good;
    // waiting one to three seconds for a second opinion must not happen.
    assert.equal(
        contextLooksBroken('confirmed', 'The LHCb experiment confirmed the existence of the Zc(4430) state, and both states are clearly seen.'),
        false
    );
    // Chinese lookalikes and dropped stops are the failure this pass exists for.
    assert.equal(contextLooksBroken('existence', 'The data set of 尸 = exotics there- （ 4230 ） ： 7。'), true);
    assert.equal(contextLooksBroken('observed', 'has only been'), true);
    assert.equal(contextLooksBroken('实验', '这个实验确认了 Zc(4430) 的存在，两个态都能在衰变中看到。'), false);
});
