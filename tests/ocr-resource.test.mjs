import test from 'node:test';
import assert from 'node:assert/strict';
import Tesseract from 'tesseract.js';
import { fileURLToPath } from 'node:url';
import { chooseTarget } from '../src/hover/core.js';

test('packaged English OCR recognizes a real bitmap and supplies usable target boxes', { timeout: 90000 }, async () => {
    const worker = await Tesseract.createWorker('eng', 1, {
        langPath: fileURLToPath(new URL('../public/tessdata/', import.meta.url)),
        cacheMethod: 'none',
    });
    try {
        const { data } = await worker.recognize(fileURLToPath(new URL('./fixtures/english-ocr.png', import.meta.url)));
        assert.match(data.text, /emergent/iu);
        const words = data.words.map((word) => ({
            text: word.text,
            line: 0,
            rect: {
                x: word.bbox.x0,
                y: word.bbox.y0,
                width: word.bbox.x1 - word.bbox.x0,
                height: word.bbox.y1 - word.bbox.y0,
            },
        }));
        const expected = words.find((word) => /emergent/iu.test(word.text));
        const result = chooseTarget(words, {
            x: expected.rect.x + expected.rect.width / 2,
            y: expected.rect.y + expected.rect.height / 2,
        });
        assert.equal(result.word, 'emergent');
        assert.match(result.context, /capabilities/iu);
    } finally {
        await worker.terminate();
    }
});
