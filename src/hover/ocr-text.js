// OCR text cleanup that must happen before word and sentence decisions.
// A Latin page read by a CJK recogniser keeps the prose but rewrites symbols as
// full-width lookalikes ("(" -> "（", "." -> "．"), so a full stop used to be
// invisible to the sentence splitter and formulas glued themselves to words.
const REPLACEMENTS = new Map([
    ['。', '.'],
    ['、', ','],
    ['‐', '-'],
    // Typographic and mathematical dashes mean "minus" or "compound" inside
    // words (π−p, K−, spin−1). Folding them keeps the term in one token instead
    // of dropping it as an unsupported symbol.
    ['−', '-'],
    ['–', '-'],
    ['﹣', '-'],
    ['～', '~'],
    ['∶', ':'],
    ['「', '"'],
    ['」', '"'],
    ['『', '"'],
    ['』', '"'],
]);

export function normalizeOcrText(value) {
    // NFKC folds full-width ASCII (（）．，：；！？－＝／＠＃％＆＊) and ligatures
    // such as ﬁ back to their plain forms; the map covers what it leaves behind.
    const folded = String(value ?? '')
        .normalize('NFKC')
        .replace(/[\u200b-\u200d\ufeff]/gu, '');
    let text = '';
    for (const character of folded) text += REPLACEMENTS.get(character) ?? character;
    return text;
}

export function isLineBreakHyphen(text) {
    return /[-‐‑\u00ad]$/u.test(text);
}

export function isBareHyphen(text) {
    return /^[-‐‑\u00ad]{1,2}$/u.test(text);
}
