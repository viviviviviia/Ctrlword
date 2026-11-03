CREATE TABLE IF NOT EXISTS chd_cache (
    cache_key TEXT PRIMARY KEY NOT NULL,
    result_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chd_vocabulary (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    word TEXT NOT NULL,
    source_lang TEXT NOT NULL,
    target_lang TEXT NOT NULL,
    context TEXT NOT NULL DEFAULT '',
    result_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    repetitions INTEGER NOT NULL DEFAULT 0 CHECK(repetitions >= 0),
    interval_days INTEGER NOT NULL DEFAULT 0 CHECK(interval_days >= 0),
    ease_factor REAL NOT NULL DEFAULT 2.5 CHECK(ease_factor >= 1.3),
    lapses INTEGER NOT NULL DEFAULT 0 CHECK(lapses >= 0),
    due_at INTEGER NOT NULL DEFAULT 0,
    last_reviewed_at INTEGER,
    suspended INTEGER NOT NULL DEFAULT 0 CHECK(suspended IN (0, 1)),
    revision INTEGER NOT NULL DEFAULT 0,
    last_quality INTEGER CHECK(last_quality BETWEEN 0 AND 5),
    last_review_token TEXT,
    UNIQUE(word, source_lang, target_lang)
);

CREATE INDEX IF NOT EXISTS chd_vocabulary_due ON chd_vocabulary(suspended, due_at);

CREATE TABLE IF NOT EXISTS chd_review_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vocabulary_id INTEGER NOT NULL REFERENCES chd_vocabulary(id) ON DELETE CASCADE,
    reviewed_at INTEGER NOT NULL,
    quality INTEGER NOT NULL CHECK(quality BETWEEN 0 AND 5),
    interval_days INTEGER NOT NULL,
    ease_factor REAL NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('scheduled', 'practice')),
    review_token TEXT UNIQUE NOT NULL
);

-- A single optimistic UPDATE and its audit record commit atomically. Frontend
-- BEGIN/COMMIT calls could otherwise use different connections in a SQL pool.
CREATE TRIGGER IF NOT EXISTS chd_log_scheduled_review
AFTER UPDATE OF revision ON chd_vocabulary
WHEN NEW.revision = OLD.revision + 1 AND NEW.last_quality IS NOT NULL
BEGIN
    INSERT INTO chd_review_log
        (vocabulary_id, reviewed_at, quality, interval_days, ease_factor, kind, review_token)
    VALUES
        (NEW.id, NEW.last_reviewed_at, NEW.last_quality, NEW.interval_days,
         NEW.ease_factor, 'scheduled', NEW.last_review_token);
END;
