import { chooseTarget } from './core.js';

// The optional Tesseract pass costs one to three seconds. Only run it when the
// Windows sentence is visibly unusable; a merely uncertain (formula-gap) frame
// must not delay the popup.
export function contextLooksBroken(word, context) {
    const text = String(context || '').trim();
    if (text.length < 24) return true;
    if (text.includes('\ufffd')) return true;
    const han = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff]/gu) || []).length;
    const latin = (text.match(/[A-Za-z]/gu) || []).length;
    // A Latin term never sits in a sentence full of Han lookalikes (Y→丫, P→尸).
    if (/^[\p{Script=Latin}\p{M}\p{N}.'\-‐‑]+$/u.test(word)) return han > 0 || latin < 8;
    return latin > han * 4;
}

export function createRecognizer({ capture, fallback }) {
    return async (id, settings, signal) => {
        // A context lookup already needs the larger local frame. OCR it once,
        // rather than first recognizing a small, possibly truncated word crop.
        const frame = await capture(id, Boolean(settings.expandContext));
        if (signal.aborted) throw new Error('Cancelled');
        let target = chooseTarget(frame.words, frame.point, frame.captureRect);
        if (!target && settings.ocrEngine !== 'system') {
            const words = await fallback(frame, settings.ocrLanguage);
            if (signal.aborted) throw new Error('Cancelled');
            target = chooseTarget(words, frame.point, frame.captureRect);
        } else if (target?.contextUncertain && settings.ocrEngine === 'auto' &&
            contextLooksBroken(target.word, target.context)) {
            // Windows OCR sometimes drops an entire inline formula and its
            // sentence-ending dot. Reuse the same frame for a second opinion.
            try {
                const words = await fallback({ ...frame, contextPass: true, recognitionRect: target.contextRect }, settings.ocrLanguage);
                if (signal.aborted) throw new Error('Cancelled');
                const alternate = chooseTarget(words, frame.point, frame.captureRect);
                if (alternate?.word.toLowerCase() === target.word.toLowerCase())
                    target = { ...target, context: alternate.context, contextUncertain: alternate.contextUncertain };
            } catch (error) {
                if (signal.aborted) throw error;
                // A failed optional context pass must not lose the valid hit.
            }
        }
        if (signal.aborted) throw new Error('Cancelled');
        if (!target) return null;
        const { rect } = target, boundary = frame.captureRect;
        // Do not send a cropped word fragment to a paid API.
        if (rect.x <= boundary.x + 1 || rect.x + rect.width >= boundary.x + boundary.width - 1) return null;
        return target;
    };
}
