import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { DUE_WORDS_SQL } from '../src/hover/queries.js';

const migration = readFileSync(new URL('../src-tauri/migrations/001_ctrlhoverdict.sql', import.meta.url), 'utf8');
function open() {
    const db = new DatabaseSync(':memory:');
    db.exec(
        "PRAGMA foreign_keys=ON; CREATE TABLE history(id INTEGER PRIMARY KEY, text TEXT); INSERT INTO history VALUES(1,'legacy')"
    );
    db.exec(migration);
    db.prepare(
        `INSERT INTO chd_vocabulary(word,source_lang,target_lang,result_json,created_at,updated_at)
        VALUES('example','en','zh_cn','{}',1,1)`
    ).run();
    return db;
}

test('migration leaves existing history intact and can create the independent schema', () => {
    const db = open();
    assert.equal(db.prepare('SELECT text FROM history').get().text, 'legacy');
    assert.equal(db.prepare('SELECT ease_factor FROM chd_vocabulary').get().ease_factor, 2.5);
    db.exec(migration);
    assert.equal(db.prepare('SELECT count(*) AS n FROM chd_vocabulary').get().n, 1);
    db.close();
});

test('optimistic review update logs exactly once and rollback covers the audit trigger', () => {
    const db = open();
    const update = db.prepare(`UPDATE chd_vocabulary SET revision=revision+1,last_quality=4,
        last_reviewed_at=100,last_review_token='token-1',interval_days=1 WHERE id=1 AND revision=0`);
    assert.equal(update.run().changes, 1);
    assert.equal(update.run().changes, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM chd_review_log').get().n, 1);
    assert.throws(
        () =>
            db.exec(`UPDATE chd_vocabulary SET revision=revision+1,last_quality=4,
        last_reviewed_at=200,last_review_token='token-1' WHERE id=1`),
        /UNIQUE/
    );
    assert.equal(db.prepare('SELECT revision FROM chd_vocabulary').get().revision, 1);
    db.close();
});

test('re-adding a word retains review progress and deleting it cascades its logs', () => {
    const db = open();
    db.exec(`UPDATE chd_vocabulary SET revision=1,last_quality=4,last_reviewed_at=100,
        last_review_token='token-2',repetitions=3,interval_days=15 WHERE id=1;
        INSERT INTO chd_vocabulary(word,source_lang,target_lang,result_json,created_at,updated_at)
        VALUES('example','en','zh_cn','{"new":true}',2,2)
        ON CONFLICT(word,source_lang,target_lang) DO UPDATE SET result_json=excluded.result_json`);
    const word = db.prepare('SELECT * FROM chd_vocabulary').get();
    assert.equal(word.repetitions, 3);
    assert.equal(word.interval_days, 15);
    db.exec('DELETE FROM chd_vocabulary WHERE id=1');
    assert.equal(db.prepare('SELECT count(*) AS n FROM chd_review_log').get().n, 0);
    db.close();
});

test('unfinished daily reinforcement survives reload without advancing the SM2 interval again', () => {
    const db = open();
    db.exec(`UPDATE chd_vocabulary SET revision=1,last_quality=0,last_reviewed_at=1500,
        last_review_token='scheduled',due_at=90000000,interval_days=1 WHERE id=1`);
    const before = db.prepare(DUE_WORDS_SQL).all({ 1: 1000, 2: 2000 });
    assert.equal(before.length, 1);
    assert.equal(before[0].practice_only, 1);
    db.exec(`INSERT INTO chd_review_log(vocabulary_id,reviewed_at,quality,interval_days,ease_factor,kind,review_token)
        VALUES(1,1600,4,1,2.5,'practice','remembered')`);
    assert.equal(db.prepare(DUE_WORDS_SQL).all({ 1: 1000, 2: 2000 }).length, 0);
    assert.equal(db.prepare('SELECT revision,interval_days FROM chd_vocabulary').get().revision, 1);
    db.close();
});
