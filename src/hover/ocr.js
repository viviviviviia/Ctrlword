import Tesseract from 'tesseract.js';
import { chooseTarget } from './core.js';
import { createRecognizer } from './recognition.js';
import { invoke } from '@tauri-apps/api/tauri';
let workerPromise, workerLanguage;
async function tesseractWords(frame, language) {
    const langs = language === 'en-US' ? 'eng' : language === 'zh-Hans-CN' ? 'chi_sim' : 'eng+chi_sim';
    if (workerPromise && workerLanguage !== langs) {
        await (await workerPromise).terminate();
        workerPromise = null;
    }
    if (!workerPromise) {
        workerLanguage = langs;
        workerPromise = Tesseract.createWorker(langs, 1, {
            workerPath: '/worker.min.js',
            corePath: '/tesseract-core-simd-lstm.wasm.js',
            langPath: '/tessdata',
            gzip: true,
        }).catch((error) => {
            workerPromise = null;
            throw error;
        });
    }
    let options = {};
    if (frame.recognitionRect) {
        const rect = frame.recognitionRect;
        const left = Math.max(0, rect.x - 4), top = Math.max(0, rect.y - 4);
        options = { rectangle: { left, top,
            width: Math.min(frame.captureRect.width - left, rect.width + 8),
            height: Math.min(frame.captureRect.height - top, rect.height + 8) },
            tessedit_pageseg_mode: '6' };
    }
    const { data } = await (await workerPromise).recognize(`data:image/png;base64,${frame.base64}`, options);
    return (data.lines || []).flatMap((line, index) =>
        (line.words || [])
            // Context must retain the actual low-confidence formula/punctuation
            // output; filtering a sentence-ending dot joins the next sentence.
            .filter((word) => frame.contextPass || word.confidence >= 35)
            .map((word) => ({
                text: word.text,
                line: index,
                rect: {
                    x: word.bbox.x0,
                    y: word.bbox.y0,
                    width: word.bbox.x1 - word.bbox.x0,
                    height: word.bbox.y1 - word.bbox.y0,
                },
            }))
    );
}
export const recognizeTarget = createRecognizer({
    capture: (id, context) => invoke('hover_capture', { id, context }),
    fallback: tesseractWords,
});
// Fast first opinion from the small crop under the cursor. The wide context
// frame follows, but the popup no longer waits for it before showing the word.
export async function recognizeQuick(id, signal) {
    const frame = await invoke('hover_capture', { id, context: false });
    if (signal?.aborted) throw new Error('Cancelled');
    const target = chooseTarget(frame.words, frame.point, frame.captureRect);
    if (!target) return null;
    const { rect } = target, boundary = frame.captureRect;
    // A word touching the crop border may be truncated; wait for the wide frame
    // rather than flashing half a term.
    if (rect.x <= boundary.x + 3 || rect.x + rect.width >= boundary.x + boundary.width - 3) return null;
    return target;
}
export async function disposeOcr() {
    if (workerPromise) {
        await (await workerPromise).terminate();
        workerPromise = null;
    }
}
