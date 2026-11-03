import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseTarget } from '../src/hover/core.js';

function row(text, x, y, line) {
    return text.split(' ').map((text) => {
        const width = text.length * 7;
        const word = { text, line, rect: { x, y, width, height: 14 } };
        x += width + 5;
        return word;
    });
}

test('keeps Although and the full multi-line sentence, excluding the adjacent PDF column', () => {
    const left = [
        row('Although many unusual states', 105, 30, 0),
        row('have been observed in experiments,', 100, 50, 1),
        row('no single theoretical description', 100, 70, 2),
        row('has become the obvious favorite.', 100, 90, 3),
        row('Another sentence follows here.', 100, 110, 4),
    ].flat();
    const right = [0, 1, 2, 3, 4].flatMap((line) => row('Unrelated right column words.', 450, 30 + line * 20, line));
    const heading = row('INTRODUCTION', 175, 0, 0);
    const words = [...heading, ...left, ...right];
    const word = words.find((word) => word.text === 'observed');
    const result = chooseTarget(words, { x: word.rect.x + 5, y: word.rect.y + 5 });
    assert.equal(result.word, 'observed');
    assert.equal(result.context, 'Although many unusual states have been observed in experiments, no single theoretical description has become the obvious favorite.');
});

test('selects only the current sentence and tolerates scientific abbreviations', () => {
    const words = [
        ...row('A previous sentence. Although Fig. 2 shows', 20, 10, 0),
        ...row('an observed state, its origin remains unclear.', 20, 30, 1),
        ...row('This is another sentence.', 20, 50, 2),
    ];
    const word = words.find((word) => word.text === 'observed');
    const result = chooseTarget(words, { x: word.rect.x + 5, y: word.rect.y + 5 });
    assert.equal(result.context, 'Although Fig. 2 shows an observed state, its origin remains unclear.');
});

test('does not join across a large paragraph gap or return text for an empty hit', () => {
    const words = [...row('Another paragraph ends.', 20, 0, 0), ...row('Observed states are interesting.', 20, 65, 1)];
    assert.equal(chooseTarget(words, { x: 25, y: 70 }).context, 'Observed states are interesting.');
    assert.equal(chooseTarget(words, { x: 900, y: 70 }), null);
});

test('both halves of a line-wrapped word select the whole word and sentence', () => {
    const words = [
        ...row('Previous sentence. The experiment con-', 20, 10, 0),
        ...row('firmed the existence of exotic states.', 20, 30, 1),
        ...row('Next sentence.', 20, 50, 2),
    ];
    for (const part of ['con-', 'firmed', 'existence']) {
        const word = words.find((word) => word.text === part);
        const result = chooseTarget(words, { x: word.rect.x + 5, y: word.rect.y + 5 });
        assert.equal(result.word, part === 'existence' ? 'existence' : 'confirmed');
        assert.equal(result.context, 'The experiment confirmed the existence of exotic states.');
    }
});

test('rejoins several wrapped words while retaining ordinary same-line compounds', () => {
    const words = [
        ...row('The diquark-antidiquark ex-', 20, 10, 0),
        ...row('otics have excita-', 20, 30, 1),
        ...row('tions analogous to ordinary quarkonium.', 20, 50, 2),
    ];
    const word = words.find((word) => word.text === 'quarkonium.');
    assert.equal(chooseTarget(words, { x: word.rect.x + 5, y: word.rect.y + 5 }).context,
        'The diquark-antidiquark exotics have excitations analogous to ordinary quarkonium.');
    const prefix = row('A cropped excita-', 20, 10, 0).at(-1);
    assert.equal(chooseTarget([prefix], { x: prefix.rect.x + 5, y: 15 }), null);
});

test('keeps clear compound hyphens across a printed line break', () => {
    for (const [first, second, expected] of [
        ['open-', 'charm', 'open-charm'], ['Born-', 'Oppenheimer', 'Born-Oppenheimer'], ['P-', 'wave', 'P-wave'],
    ]) {
        const words = [...row(`The ${first}`, 20, 10, 0), ...row(`${second} states exist.`, 20, 30, 1)];
        for (const part of [first, second]) {
            const word = words.find((word) => word.text === part);
            const result = chooseTarget(words, { x: word.rect.x + 3, y: word.rect.y + 5 });
            assert.equal(result.word, expected);
            assert.equal(result.context, `The ${expected} states exist.`);
        }
    }
});

test('sentence boundaries retain Sec., i.e., decimal points and references', () => {
    const words = [
        ...row('Previous sentence. In Sec. III we review the cur-', 20, 10, 0),
        ...row('rent status at 4.35 MeV (i.e., above the 1S states),', 20, 30, 1),
        ...row('identifying known P = - states [13]. Next sentence.', 20, 50, 2),
    ];
    const word = words.find((word) => word.text === 'known');
    assert.equal(chooseTarget(words, { x: word.rect.x + 5, y: word.rect.y + 5 }).context,
        'In Sec. III we review the current status at 4.35 MeV (i.e., above the 1S states), identifying known P = - states [13].');
});

test('formula spacing and superscripts do not isolate the target from its sentence', () => {
    const words = [
        ...row('Previous sentence. Only the experiment con-', 20, 10, 0),
        ...row('firmed the existence of the', 20, 30, 1),
        { text: '1', rect: { x: 230, y: 30, width: 7, height: 14 } },
        { text: '+-', rect: { x: 238, y: 25, width: 9, height: 7 } },
        { text: 'Zc(4430)', rect: { x: 277, y: 30, width: 56, height: 14 } },
        { text: '[35],', rect: { x: 338, y: 30, width: 35, height: 14 } },
        ...row('and both states decay to particles.', 20, 50, 2),
        ...row('Unrelated right column.', 600, 30, 1),
    ];
    const word = words.find((word) => word.text === 'existence');
    const context = chooseTarget(words, { x: word.rect.x + 5, y: word.rect.y + 5 }).context;
    assert.match(context, /^Only the experiment confirmed the existence of the/);
    assert.match(context, /Zc\(4430\) \[35\], and both states decay to particles\.$/);
    assert.ok(!context.includes('Unrelated'));
});

test('wider formula tolerance does not merge a narrow prose column gutter', () => {
    const left = row('The observed states are known.', 20, 10, 0);
    const right = row('Unrelated text in another column.', left.at(-1).rect.x + left.at(-1).rect.width + 32, 10, 0);
    const target = left[1];
    assert.equal(chooseTarget([...left, ...right], { x: target.rect.x + 3, y: 15 }).context,
        'The observed states are known.');
});

test('a hyphen printed as its own token still rejoins the wrapped word', () => {
    const words = [
        ...row('Previous sentence. The experiment con -', 20, 10, 0),
        ...row('firmed the existence of exotic states.', 20, 30, 1),
    ];
    for (const part of ['con', 'firmed', 'existence']) {
        const word = words.find((word) => word.text === part);
        const result = chooseTarget(words, { x: word.rect.x + 3, y: word.rect.y + 5 });
        assert.equal(result.word, part === 'existence' ? 'existence' : 'confirmed');
        assert.equal(result.context, 'The experiment confirmed the existence of exotic states.');
    }
});

test('a continuation hyphenated on its own line is rejoined after the prefix', () => {
    const words = [
        ...row('Previous sentence. The experiment con', 20, 10, 0),
        ...row('-firmed the existence of states.', 20, 30, 1),
    ];
    const word = words.find((word) => word.text === '-firmed');
    assert.equal(chooseTarget(words, { x: word.rect.x + 3, y: word.rect.y + 5 }).word, 'confirmed');
});

test('a minus sign inside a sentence is context, not a wrapped word', () => {
    const words = [...row('States with P = - parity were seen.', 20, 10, 0)];
    const word = words.find((word) => word.text === 'parity');
    assert.equal(chooseTarget(words, { x: word.rect.x + 3, y: word.rect.y + 5 }).context,
        'States with P = - parity were seen.');
});

test('full-width OCR punctuation is folded before sentence decisions', () => {
    const words = [
        ...row('Previous sentence. The six states Y （ 4660 ） ． Zc （ 4240 ） has', 20, 10, 0),
        ...row('only been observed in the LHCb experiment.', 20, 30, 1),
    ];
    const word = words.find((word) => word.text === 'observed');
    assert.equal(chooseTarget(words, { x: word.rect.x + 3, y: word.rect.y + 5 }).context,
        'Zc (4240) has only been observed in the LHCb experiment.');
});

test('a stop that lost its trailing space still ends the sentence, decimals never do', () => {
    const words = [
        ...row('Previous sentence. The experiment confirms 4.35MeV states', 20, 10, 0),
        ...row('and mysteries.Yet another sentence follows here.', 20, 30, 1),
    ];
    const first = words.find((word) => word.text === 'states');
    assert.equal(chooseTarget(words, { x: first.rect.x + 3, y: first.rect.y + 5 }).context,
        'The experiment confirms 4.35MeV states and mysteries.');
    const second = words.find((word) => word.text === 'another');
    assert.equal(chooseTarget(words, { x: second.rect.x + 3, y: second.rect.y + 5 }).context,
        'Yet another sentence follows here.');
});
