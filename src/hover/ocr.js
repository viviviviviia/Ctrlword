import Tesseract from 'tesseract.js';
import { chooseTarget } from './core.js';
import { createRecognizer } from './recognition.js';
import { invoke } from '@tauri-apps/api/tauri';
let workerPromise, workerLanguage;
// Windows OCR occasionally never answers (a stuck engine call). Without a
// deadline the whole lookup would stay pending forever and every later tap
// would be dropped as "busy" until the app is restarted.
function withDeadline(promise, ms, label) {
    let timer;
    const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}超时，请再试一次`)), ms);
    });
    return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
const CAPTURE_DEADLINE_MS = 8000;
const TESSERACT_DEADLINE_MS = 20000;
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
    capture: (id, context) =>
        withDeadline(invoke('hover_capture', { id, context }), CAPTURE_DEADLINE_MS, '截图识别'),
    fallback: (frame, language) =>
        withDeadline(tesseractWords(frame, language), TESSERACT_DEADLINE_MS, '补充识别'),
});
// Fast first opinion from the small crop under the cursor. The wide context
// frame follows, but the popup no longer waits for it before showing the word.
export async function recognizeQuick(id, signal) {
    const frame = await withDeadline(
        invoke('hover_capture', { id, context: false }),
        CAPTURE_DEADLINE_MS,
        '截图识别'
    );
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
