export const DUE_WORDS_SQL = `SELECT v.*,
    CASE WHEN last_reviewed_at >= $1 AND last_quality < 4 THEN 1 ELSE 0 END AS practice_only
    FROM chd_vocabulary v WHERE suspended=0 AND (due_at<=$2 OR
    (last_reviewed_at >= $1 AND last_quality < 4 AND NOT EXISTS
    (SELECT 1 FROM chd_review_log r WHERE r.vocabulary_id=v.id AND r.kind='practice'
     AND r.quality>=4 AND r.reviewed_at>=v.last_reviewed_at))) ORDER BY due_at,id`;
