import Database from 'tauri-plugin-sql-api';
import { dictionaryCacheKey, normalizeDictionary, scheduleReview } from './core.js';
import { DUE_WORDS_SQL } from './queries.js';

let database;
export function getDatabase() {
    // Schema is applied by the existing Tauri SQL plugin's versioned migrations.
    database ??= Database.load('sqlite:ctrlhoverdict.db').catch((error) => {
        database = null;
        throw error;
    });
    return database;
}

export async function getCached(query) {
    const db = await getDatabase();
    const key = dictionaryCacheKey(query);
    const rows = await db.select('SELECT result_json FROM chd_cache WHERE cache_key=$1', [key]);
    if (!rows.length) return null;
    try {
        return { ...normalizeDictionary(JSON.parse(rows[0].result_json), query), cached: true };
    } catch {
        await db.execute('DELETE FROM chd_cache WHERE cache_key=$1', [key]);
        return null;
    }
}

export async function putCached(query, result) {
    const db = await getDatabase();
    await db.execute(
        'INSERT INTO chd_cache(cache_key,result_json,created_at) VALUES($1,$2,$3) ' +
            'ON CONFLICT(cache_key) DO UPDATE SET result_json=excluded.result_json,created_at=excluded.created_at',
        [dictionaryCacheKey(query), JSON.stringify(result), Date.now()]
    );
}

export async function clearCache() {
    await (await getDatabase()).execute('DELETE FROM chd_cache');
}

export async function saveWord(result) {
    const db = await getDatabase();
    const timestamp = Date.now();
    await db.execute(
        `INSERT INTO chd_vocabulary
        (word,source_lang,target_lang,context,result_json,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$6)
        ON CONFLICT(word,source_lang,target_lang) DO UPDATE SET
        context=excluded.context,result_json=excluded.result_json,updated_at=excluded.updated_at`,
        [
            result.word,
            result.sourceLanguage,
            result.targetLanguage,
            result.context || '',
            JSON.stringify(result),
            timestamp,
        ]
    );
}

export async function listWords(search = '') {
    const db = await getDatabase();
    return db.select(
        `SELECT * FROM chd_vocabulary WHERE word LIKE $1 ESCAPE '\\'
        OR context LIKE $1 ESCAPE '\\' ORDER BY created_at DESC`,
        ['%' + search.replace(/[\\%_]/gu, '\\$&') + '%']
    );
}

export async function dueWords() {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    return (await getDatabase()).select(DUE_WORDS_SQL, [start.getTime(), end.getTime()]);
}

export async function deleteWord(id) {
    await (await getDatabase()).execute('DELETE FROM chd_vocabulary WHERE id=$1', [id]);
}

export async function suspendWord(id, suspend) {
    await (await getDatabase()).execute('UPDATE chd_vocabulary SET suspended=$1 WHERE id=$2', [Number(suspend), id]);
}

export async function gradeWord(word, quality, practice = false, token = crypto.randomUUID()) {
    const db = await getDatabase();
    const timestamp = Date.now();
    if (practice) {
        // Same-session reinforcement must not advance the long-term interval twice in one day.
        await db.execute(
            `INSERT OR IGNORE INTO chd_review_log
            (vocabulary_id,reviewed_at,quality,interval_days,ease_factor,kind,review_token)
            VALUES($1,$2,$3,$4,$5,'practice',$6)`,
            [word.id, timestamp, quality, word.interval_days, word.ease_factor, token]
        );
        return word;
    }
    const state = scheduleReview(
        {
            repetitions: word.repetitions,
            intervalDays: word.interval_days,
            easeFactor: word.ease_factor,
            lapses: word.lapses,
        },
        quality,
        timestamp
    );
    const update = await db.execute(
        `UPDATE chd_vocabulary SET repetitions=$1,interval_days=$2,
        ease_factor=$3,lapses=$4,due_at=$5,last_reviewed_at=$6,last_quality=$7,
        last_review_token=$8,revision=revision+1 WHERE id=$9 AND revision=$10 AND suspended=0`,
        [
            state.repetitions,
            state.intervalDays,
            state.easeFactor,
            state.lapses,
            state.dueAt,
            timestamp,
            quality,
            token,
            word.id,
            word.revision,
        ]
    );
    if (update.rowsAffected !== 1) throw new Error('此词的复习进度已改变，请刷新复习列表。');
    return {
        ...word,
        interval_days: state.intervalDays,
        ease_factor: state.easeFactor,
        repetitions: state.repetitions,
        lapses: state.lapses,
        due_at: state.dueAt,
        revision: word.revision + 1,
    };
}
