// Pure logic shared by the hover controller, cache and review pages.
// Keep this module independent of Tauri so the important decisions are testable.
import { readingContext } from './context.js';
import { normalizeOcrText } from './ocr-text.js';
export const DAY_MS = 86_400_000;
export const DICTIONARY_SCHEMA = 1;
export const PROMPT_VERSION = 1;

export function cleanText(value) {
    return String(value ?? '')
        .normalize('NFC')
        .replace(/[\u200b-\u200d\ufeff]/gu, '')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
        .replace(/\s+/gu, ' ')
        .trim();
}

export function cleanWord(value) {
    const word = cleanText(normalizeOcrText(value))
        .replace(/[‘’]/gu, "'")
        .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (!word || word.length > 80 || /\s|\ufffd/gu.test(word)) return null;
    if (!/\p{L}/u.test(word)) return null;
    // Unicode letters/marks allow non-English words without treating all symbols as words.
    if (!/^[\p{L}\p{M}\p{N}.'\-‐‑]+$/u.test(word)) return null;
    if (word.includes('.') && !/^(?:\p{L}\.)+\p{L}$/u.test(word)) return null;
    return word;
}

export function inside(rect, point, padding = 0) {
    return (
        Number.isFinite(rect?.x) &&
        Number.isFinite(rect?.y) &&
        rect.width > 0 &&
        rect.height > 0 &&
        point.x >= rect.x - padding &&
        point.x <= rect.x + rect.width + padding &&
        point.y >= rect.y - padding &&
        point.y <= rect.y + rect.height + padding
    );
}

function distanceTo(entry, point) {
    return Math.hypot(
        point.x - entry.rect.x - entry.rect.width / 2,
        point.y - entry.rect.y - entry.rect.height / 2
    );
}

// Symbols, brackets and subscripts are not words themselves, but they belong to
// the term next to them (Zc(4430), ψ(2S), P−wave). Clicking one used to do
// nothing at all, so fall back to the closest real word within a small halo.
function nearest(words, point) {
    const halo = 8;
    return words
        .map((entry, index) => ({ ...entry, index, word: cleanWord(entry.text) }))
        .filter((entry) => entry.word && (
            point.x >= entry.rect.x - halo && point.x <= entry.rect.x + entry.rect.width + halo &&
            point.y >= entry.rect.y - halo && point.y <= entry.rect.y + entry.rect.height + halo
        ))
        .sort((a, b) => distanceTo(a, point) - distanceTo(b, point))[0];
}

export function chooseTarget(words, point, origin = { x: 0, y: 0 }) {
    const local = { x: point.x - origin.x, y: point.y - origin.y };
    const candidates = words
        .map((entry, index) => ({ ...entry, index, word: cleanWord(entry.text) }))
        .filter((entry) => entry.word && (
            inside(entry.rect, local, 3) || (
                local.x >= entry.rect.x - 3 && local.x <= entry.rect.x + entry.rect.width + 3 &&
                local.y > entry.rect.y + entry.rect.height && local.y <= entry.rect.y + entry.rect.height + 12
            )
        ));
    // Prefer exact containment over the small whitespace allowance, then the nearest centre.
    candidates.sort((a, b) => {
        const exact = Number(inside(b.rect, local)) - Number(inside(a.rect, local));
        if (exact) return exact;
        return distanceTo(a, local) - distanceTo(b, local);
    });
    const selected = candidates[0] ?? nearest(words, local);
    if (!selected) return null;
    const reading = readingContext(words, selected.index);
    // Do not translate a known line-end prefix without its continuation.
    if (/[-‐‑‒–—―\u00ad]$/u.test(reading.selectedText)) return null;
    const word = cleanWord(reading.selectedText);
    if (!word) return null;
    const context = cleanText(reading.context);
    return {
        word,
        context,
        contextUncertain: Boolean(reading.contextUncertain),
        contextRect: reading.contextRect,
        rect: { ...selected.rect, x: selected.rect.x + origin.x, y: selected.rect.y + origin.y },
    };
}

export function dictionaryCacheKey(query) {
    let endpoint = '';
    try { const url = new URL(query.endpoint); endpoint = `${url.protocol}//${url.host}${url.pathname}`; } catch { /* No endpoint for ordinary Pot services. */ }
    return JSON.stringify([
        DICTIONARY_SCHEMA,
        query.promptVersion ?? PROMPT_VERSION,
        cleanText(query.word),
        cleanText(query.context),
        query.from ?? 'auto',
        query.to,
        query.provider,
        query.model ?? '',
        endpoint,
    ]);
}

export function relativeSelection(start, end, screen) {
    const left = Math.max(0, Math.min(start.x, end.x) - screen.x);
    const top = Math.max(0, Math.min(start.y, end.y) - screen.y);
    const right = Math.min(screen.width, Math.max(start.x, end.x) - screen.x);
    const bottom = Math.min(screen.height, Math.max(start.y, end.y) - screen.y);
    if (right <= left || bottom <= top) return null;
    return {
        left: Math.floor(left),
        top: Math.floor(top),
        width: Math.floor(right - left),
        height: Math.floor(bottom - top),
    };
}

export function newReviewState() {
    return { repetitions: 0, intervalDays: 0, easeFactor: 2.5, lapses: 0, dueAt: 0, lastReviewedAt: null };
}

export function scheduleReview(previous, quality, timestamp = Date.now()) {
    if (!Number.isInteger(quality) || quality < 0 || quality > 5) throw new RangeError('Quality must be 0–5');
    const now = new Date(timestamp);
    if (!Number.isFinite(now.getTime())) throw new RangeError('Invalid review time');
    const state = { ...newReviewState(), ...previous };
    const ease = Math.max(1.3, Number(state.easeFactor) || 2.5);
    let repetitions = quality < 3 ? 0 : state.repetitions + 1;
    const intervalDays =
        quality < 3 || repetitions === 1
            ? 1
            : repetitions === 2
              ? 6
              : Math.ceil(Math.max(1, state.intervalDays) * ease);
    const next = new Date(now);
    next.setDate(next.getDate() + intervalDays); // Calendar days also work across local DST changes.
    return {
        repetitions,
        intervalDays,
        easeFactor: Math.max(1.3, Number((ease + 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)).toFixed(4))),
        lapses: state.lapses + Number(quality < 3),
        dueAt: next.getTime(),
        lastReviewedAt: now.getTime(),
    };
}

export function normalizeDictionary(value, query) {
    const source = typeof value === 'string' ? { senses: [{ definition: cleanText(value) }] } : value;
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('Invalid dictionary result');
    const senses = (Array.isArray(source.senses) ? source.senses : [])
        .filter((item) => item && typeof item.definition === 'string' && cleanText(item.definition))
        .map((item) => ({
            definition: cleanText(item.definition),
            partOfSpeech: cleanText(item.partOfSpeech) || null,
        }));
    if (!senses.length) throw new Error('Dictionary result has no valid definition');
    const pairs = (items, first, second) =>
        (Array.isArray(items) ? items : [])
            .filter((item) => item && typeof item[first] === 'string' && cleanText(item[first]))
            .slice(0, 10)
            .map((item) => ({ [first]: cleanText(item[first]), [second]: cleanText(item[second]) || null }));
    return {
        schemaVersion: DICTIONARY_SCHEMA,
        word: query.word,
        sourceLanguage: cleanText(source.sourceLanguage) || query.from || 'auto',
        targetLanguage: query.to,
        phonetics: (Array.isArray(source.phonetics) ? source.phonetics : [])
            .filter((item) => typeof item === 'string' && cleanText(item))
            .slice(0, 4)
            .map(cleanText),
        senses: senses.slice(0, 12),
        collocations: pairs(source.collocations, 'text', 'translation'),
        examples: pairs(source.examples, 'text', 'translation'),
        context: query.context,
        contextTranslation: cleanText(source.contextTranslation) || null,
        provider: query.provider,
        model: query.model || null,
        cached: false,
    };
}

// Read only completed top-level JSON values. Never execute or display raw model markup.
export function completedJsonFields(input) {
    const text = String(input).slice(0, 128_000);
    let cursor = text.indexOf('{') + 1;
    if (!cursor) return {};
    const result = {};
    const stringEnd = (start) => {
        let escaped = false;
        for (let index = start + 1; index < text.length; index++) {
            if (!escaped && text[index] === '"') return index + 1;
            if (!escaped && text[index] === '\\') escaped = true;
            else escaped = false;
        }
        return -1;
    };
    while (cursor < text.length) {
        while (/[\s,]/u.test(text[cursor] ?? '') && cursor < text.length) cursor++;
        if (text[cursor] !== '"') break;
        const keyEnd = stringEnd(cursor);
        if (keyEnd < 0) break;
        let key;
        try {
            key = JSON.parse(text.slice(cursor, keyEnd));
        } catch {
            break;
        }
        cursor = keyEnd;
        while (/\s/u.test(text[cursor] ?? '') && cursor < text.length) cursor++;
        if (text[cursor++] !== ':') break;
        while (/\s/u.test(text[cursor] ?? '') && cursor < text.length) cursor++;
        const start = cursor;
        let end = -1;
        if (text[start] === '"') end = stringEnd(start);
        else if (text[start] === '[' || text[start] === '{') {
            let depth = 0;
            for (let index = start; index < text.length; index++) {
                if (text[index] === '"') {
                    const next = stringEnd(index);
                    if (next < 0) break;
                    index = next - 1;
                } else if ('[{'.includes(text[index])) depth++;
                else if (']}'.includes(text[index]) && --depth === 0) {
                    end = index + 1;
                    break;
                }
            }
        } else {
            const match = text.slice(start).match(/^(?:true|false|null|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*(?=[,}])/iu);
            if (match) end = start + match[0].length;
        }
        if (end < 0) break;
        try {
            // Define explicitly: an untrusted __proto__ key must remain ordinary data.
            Object.defineProperty(result, key, { value: JSON.parse(text.slice(start, end)), enumerable: true });
        } catch {
            break;
        }
        cursor = end;
    }
    return result;
}
