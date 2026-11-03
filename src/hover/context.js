// Reconstruct the local reading column before finding sentence boundaries.
// OCR line IDs can merge adjacent PDF columns, so use word geometry instead.
import { isBareHyphen, isLineBreakHyphen, normalizeOcrText } from './ocr-text.js';

const COMPOUND_PREFIX = /^(?:anti|non|self|well|open|hidden|heavy|light|spin|color|colour|low|high|first|second|third)$/iu;
const BOUNDARY = /[.!?]+["'”’»)\]｝」』）】]*(?=[\s\u3000]|\p{Lu}|$)/gu;
const ABBREVIATION = /(?:\b(?:e\.g|i\.e|Dr|Mr|Mrs|Ms|Prof|Fig|Figs|Eq|Eqs|Ref|Refs|Sec|Secs|vs|al|No)|\b[A-Z])\.$/u;

export function readingContext(words, selectedIndex) {
    const entries = words
        .map((word, index) => ({ ...word, index, text: normalizeOcrText(word.text).trim() }))
        .filter((word) => word.text && word.rect?.width > 0 && word.rect?.height > 0);
    if (!entries.length) return { context: '', selectedText: '' };
    const heights = entries.map((word) => word.rect.height).sort((a, b) => a - b);
    const height = heights[Math.floor(heights.length / 2)];
    const rows = [];
    for (const word of entries.sort((a, b) => centre(a) - centre(b) || a.rect.x - b.rect.x)) {
        let row = rows.at(-1);
        if (!row || Math.abs(row.y - centre(word)) > Math.max(2, height * 0.75)) {
            row = { y: centre(word), words: [] };
            rows.push(row);
        }
        row.words.push(word);
        // Tiny superscripts must not pull the printed baseline upwards.
        const body = row.words.filter((item) => item.rect.height >= height * 0.7);
        const samples = body.length ? body : row.words;
        row.y = samples.reduce((sum, item) => sum + centre(item), 0) / samples.length;
    }
    for (const row of rows) {
        row.fragments = [];
        for (const word of row.words.sort((a, b) => a.rect.x - b.rect.x)) {
            let fragment = row.fragments.at(-1);
            const previous = fragment?.words.at(-1);
            // Permit the extra spacing used around short math tokens, but keep
            // normal prose gutters narrow enough to separate adjacent columns.
            const mathGap = previous && [previous.text, word.text].some((text) =>
                text.length <= 12 && /[\d=+−δψΓ]/u.test(text));
            const maxGap = Math.max(12, height * (mathGap ? 2.5 : 1.5));
            if (!fragment || word.rect.x - fragment.right > maxGap) {
                fragment = { left: word.rect.x, right: word.rect.x, words: [], y: row.y };
                row.fragments.push(fragment);
            }
            fragment.words.push(word);
            fragment.right = Math.max(fragment.right, word.rect.x + word.rect.width);
        }
    }
    const hit = entries.find((word) => word.index === selectedIndex);
    if (hit) {
        // A real column gutter repeats down the page. A formula-sized hole in
        // one line does not. Infer the local column before filling such holes.
        const nearby = rows.filter((row) => Math.abs(row.y - centre(hit)) < height * 10 && row.words.length >= 3);
        const gaps = nearby.map((row) => row.words.slice(1).map((word, index) => ({
            left: row.words[index].rect.x + row.words[index].rect.width, right: word.rect.x,
        })).filter((gap) => gap.right - gap.left > height * 1.5));
        const gutters = gaps.flat().map((gap) => (gap.left + gap.right) / 2).filter((x) =>
            gaps.filter((items) => items.some((gap) => gap.left < x && gap.right > x)).length >= Math.max(3, Math.ceil(nearby.length * 0.4)));
        const x = hit.rect.x + hit.rect.width / 2;
        const left = Math.max(-Infinity, ...gutters.filter((value) => value < x));
        const right = Math.min(Infinity, ...gutters.filter((value) => value > x));
        if (Number.isFinite(left) || Number.isFinite(right)) {
            for (const row of rows) {
                const column = row.words.filter((word) => word.rect.x >= left && word.rect.x + word.rect.width <= right);
                row.fragments = column.length ? [{ left: column[0].rect.x,
                    right: column.at(-1).rect.x + column.at(-1).rect.width, words: column, y: row.y }] : [];
            }
        }
    }
    const rowIndex = rows.findIndex((row) => row.fragments.some((part) => part.words.some((word) => word.index === selectedIndex)));
    if (rowIndex < 0) return { context: '', selectedText: '' };
    const selected = rows[rowIndex].fragments.find((part) => part.words.some((word) => word.index === selectedIndex));
    const fragments = [selected];
    for (const direction of [-1, 1]) {
        let previous = selected;
        let bounds = { left: selected.left, right: selected.right };
        for (let index = rowIndex + direction; index >= 0 && index < rows.length; index += direction) {
            const row = rows[index];
            if (Math.abs(row.y - previous.y) > height * 1.85) break;
            const candidates = row.fragments
                .map((part) => ({ part, overlap: Math.min(bounds.right, part.right) - Math.max(bounds.left, part.left) }))
                .filter(({ part, overlap }) => overlap > 0 && overlap >= Math.min(bounds.right - bounds.left, part.right - part.left) * 0.3)
                .sort((a, b) => b.overlap - a.overlap);
            const next = candidates[0]?.part;
            if (!next) continue;
            if (direction < 0) fragments.unshift(next);
            else fragments.push(next);
            bounds = { left: Math.min(bounds.left, next.left), right: Math.max(bounds.right, next.right) };
            previous = next;
        }
    }
    // Neighbouring full-width prose rows establish the column envelope. A
    // formula can create a much larger gap *within* that column than its gutter.
    const columnLeft = Math.min(...fragments.map((part) => part.left));
    const columnRight = Math.max(...fragments.map((part) => part.right));
    const tokens = [];
    for (const fragment of fragments) {
        const row = rows.find((row) => row.fragments.includes(fragment));
        const columnWords = row.words.filter((word) =>
            word.rect.x >= columnLeft - 2 && word.rect.x + word.rect.width <= columnRight + 2)
            .sort((a, b) => a.rect.x - b.rect.x);
        columnWords.forEach((word, index) => {
            const previous = tokens.at(-1);
            // A wrapped word is sometimes split into three OCR tokens ("con", "-",
            // "firmed"). A hyphen alone at the end of a printed line still marks
            // the break, so append it to the prefix and let the join below run.
            if (isBareHyphen(word.text)) {
                if (index === columnWords.length - 1 && previous && /\p{Script=Latin}$/u.test(previous.text)) {
                    previous.text += '-';
                    previous.indices.push(word.index);
                    return;
                }
                // A minus sign inside a sentence ("P = - states") is not a break.
                tokens.push({ text: word.text, indices: [word.index] });
                return;
            }
            const first = index === 0;
            const trimmed = first ? word.text.replace(/^[-‐‑\u00ad]{1,2}(?=\p{L})/u, '') : word.text;
            const previousText = previous?.text ?? '';
            const head = isLineBreakHyphen(previousText) ? previousText.slice(0, -1) : previousText;
            const linePrefix = head.match(/(\p{Script=Latin}+)$/u)?.[1];
            const hyphenated = Boolean(previous && isLineBreakHyphen(previousText) && linePrefix);
            const wrapped = trimmed !== word.text;
            // Join only across printed lines; same-line compounds keep '-'.
            const broken = Boolean(first && previous && (
                (hyphenated && (/^\p{Ll}/u.test(trimmed) || /^\p{Lu}/u.test(linePrefix) || /^\p{Script=Latin}/u.test(trimmed))) ||
                (wrapped && /\p{L}$/u.test(head))
            ));
            if (broken) {
                // Retain clear compound prefixes/proper names (open-charm,
                // Born-Oppenheimer, P-wave); arbitrary lexical ambiguity still
                // cannot be resolved perfectly from OCR geometry alone.
                const compound = !linePrefix || linePrefix.length === 1 || /^\p{Lu}/u.test(linePrefix) ||
                    COMPOUND_PREFIX.test(linePrefix);
                previous.text = head + (compound ? '-' : '') + trimmed;
                previous.indices.push(word.index);
                return;
            }
            tokens.push({ text: trimmed, indices: [word.index], gap: index > 0 &&
                word.rect.x - columnWords[index - 1].rect.x - columnWords[index - 1].rect.width > Math.max(12, height * 1.5) });
        });
    }
    let text = '', selectedStart = 0, selectedEnd = 0, selectedText = '';
    const gaps = [];
    for (const token of tokens) {
        if (text && !/^[,.;:!?。！？)\]}]/u.test(token.text) && !/[(\[{]$/u.test(text)) text += ' ';
        if (token.gap) gaps.push(text.length);
        if (token.indices.includes(selectedIndex)) {
            selectedStart = text.length;
            selectedEnd = text.length + token.text.length;
            selectedText = token.text;
        }
        text += token.text;
    }
    let start = 0, end = text.length;
    for (const match of text.matchAll(BOUNDARY)) {
        const boundary = match.index + match[0].length;
        const before = text[match.index - 1] ?? '';
        const after = text[boundary] ?? '';
        // "4.35MeV" has no space after the point. A real stop that lost its
        // trailing space to OCR still ends the sentence, a decimal cannot.
        if (/\d/u.test(before) && !/[\s\u3000]/u.test(after)) continue;
        if (match[0][0] === '.' && match[0][1] !== '.' && ABBREVIATION.test(text.slice(0, match.index + 1))) continue;
        if (boundary <= selectedStart) start = boundary;
        if (boundary >= selectedEnd) { end = boundary; break; }
    }
    let context = text.slice(start, end).trim();
    if (context.length > 1200) {
        const offset = Math.max(0, selectedStart - start - 400);
        context = context.slice(offset, offset + 1200);
    }
    const top = Math.min(...fragments.flatMap((part) => part.words.map((word) => word.rect.y)));
    const bottom = Math.max(...fragments.flatMap((part) => part.words.map((word) => word.rect.y + word.rect.height)));
    return { context, selectedText, contextUncertain: gaps.some((position) => position >= start && position < end),
        contextRect: { x: columnLeft, y: top, width: columnRight - columnLeft, height: bottom - top } };
}

export function sentenceContext(words, selectedIndex) {
    return readingContext(words, selectedIndex).context;
}

function centre(word) { return word.rect.y + word.rect.height / 2; }
