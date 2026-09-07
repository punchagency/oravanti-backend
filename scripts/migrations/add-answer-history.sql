-- One answer set per matter.
--
-- A data repair, not a schema change. The history tables and their RLS
-- policies are declared in src/db/schema and applied by `npm run db:setup`;
-- this file exists only for the part drizzle has no way to express — moving
-- rows that are already in the database.
--
-- ─── Why the consolidation is needed ────────────────────────────────────────
--
-- Each send used to create its own response row with no prior answers. A matter
-- sent a questionnaire twice therefore had two responses, the client started
-- from blank the second time, and the form resolver read whichever row its
-- ORDER BY happened to pick — which, with the status enum declared
-- ("draft", "submitted") and no DESC, was the *oldest draft*. On a matter with
-- an empty early draft it selected the one row with nothing in it and reported
-- "no answers" forever, leaving every form on `not_started`.
--
-- Run once, after the schema is up to date:
--
--   npm run db:setup
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/migrations/add-answer-history.sql

BEGIN;

-- ─── 1. One answer set per matter ───────────────────────────────────────────
--
-- The keeper for each matter is the response with the most answers, breaking
-- ties on the most recently saved. Answers are moved onto it, and where both
-- rows answered the same question the newer answer wins.

CREATE TEMP TABLE keepers ON COMMIT DROP AS
SELECT DISTINCT ON (r.case_id)
       r.id AS keeper_id,
       r.case_id,
       r.organization_id
FROM questionnaire_responses r
JOIN questionnaires qn ON qn.id = r.questionnaire_id
WHERE qn.stage = 'case' AND r.case_id IS NOT NULL
ORDER BY r.case_id,
         (SELECT count(*) FROM questionnaire_answers a WHERE a.response_id = r.id) DESC,
         r.last_saved_at DESC;

CREATE TEMP TABLE losers ON COMMIT DROP AS
SELECT r.id AS loser_id, k.keeper_id, k.case_id
FROM questionnaire_responses r
JOIN questionnaires qn ON qn.id = r.questionnaire_id
JOIN keepers k ON k.case_id = r.case_id
WHERE qn.stage = 'case' AND r.id <> k.keeper_id;

-- Move answers the keeper does not already have.
UPDATE questionnaire_answers a
SET response_id = l.keeper_id
FROM losers l
WHERE a.response_id = l.loser_id
  AND NOT EXISTS (
    SELECT 1 FROM questionnaire_answers k
    WHERE k.response_id = l.keeper_id AND k.question_id = a.question_id
  );

-- Where both answered the same question, keep the newer value.
UPDATE questionnaire_answers k
SET value = a.value, updated_at = a.updated_at
FROM questionnaire_answers a
JOIN losers l ON l.loser_id = a.response_id
WHERE k.response_id = l.keeper_id
  AND k.question_id = a.question_id
  AND a.updated_at > k.updated_at;

-- Uploaded documents follow their answers.
UPDATE questionnaire_response_files f
SET response_id = l.keeper_id
FROM losers l
WHERE f.response_id = l.loser_id
  AND NOT EXISTS (
    SELECT 1 FROM questionnaire_response_files k
    WHERE k.response_id = l.keeper_id AND k.question_id = f.question_id
  );

-- The keeper carries the strongest status the matter ever reached, and the
-- most recent send that delivered it.
UPDATE questionnaire_responses k
SET status = 'submitted',
    submitted_at = COALESCE(k.submitted_at, sub.submitted_at)
FROM (
  SELECT l.keeper_id, max(r.submitted_at) AS submitted_at
  FROM losers l
  JOIN questionnaire_responses r ON r.id = l.loser_id
  WHERE r.status = 'submitted'
  GROUP BY l.keeper_id
) sub
WHERE k.id = sub.keeper_id AND k.status <> 'submitted';

UPDATE questionnaire_responses k
SET questionnaire_send_id = sub.send_id
FROM (
  SELECT DISTINCT ON (l.keeper_id) l.keeper_id, r.questionnaire_send_id AS send_id
  FROM losers l
  JOIN questionnaire_responses r ON r.id = l.loser_id
  WHERE r.questionnaire_send_id IS NOT NULL
  ORDER BY l.keeper_id, r.last_saved_at DESC
) sub
WHERE k.id = sub.keeper_id AND k.questionnaire_send_id IS NULL;

DELETE FROM questionnaire_responses r USING losers l WHERE r.id = l.loser_id;

-- ─── 2. Seed version 1 ──────────────────────────────────────────────────────
--
-- So a matter that already has answers does not present an empty history. One
-- snapshot of where things stand, attributed to the client, with no revision
-- rows behind it — there is no record of how those answers got there, and
-- inventing one would be worse than showing none.

INSERT INTO questionnaire_response_versions
  (organization_id, response_id, version_number, actor, answers, changed_count)
SELECT r.organization_id,
       r.id,
       1,
       'client',
       COALESCE(
         (SELECT jsonb_object_agg(a.question_id::text, a.value)
          FROM questionnaire_answers a WHERE a.response_id = r.id),
         '{}'::jsonb
       ),
       (SELECT count(*) FROM questionnaire_answers a WHERE a.response_id = r.id)
FROM questionnaire_responses r
JOIN questionnaires qn ON qn.id = r.questionnaire_id
WHERE qn.stage = 'case'
  AND EXISTS (SELECT 1 FROM questionnaire_answers a WHERE a.response_id = r.id)
ON CONFLICT (response_id, version_number) DO NOTHING;

-- ─── 3. Report ──────────────────────────────────────────────────────────────

SELECT 'case responses remaining' AS metric, count(*) AS value
FROM questionnaire_responses r
JOIN questionnaires qn ON qn.id = r.questionnaire_id WHERE qn.stage = 'case'
UNION ALL
SELECT 'matters with a case response',
       count(DISTINCT r.case_id)
FROM questionnaire_responses r
JOIN questionnaires qn ON qn.id = r.questionnaire_id WHERE qn.stage = 'case'
UNION ALL
SELECT 'case answers', count(*) FROM questionnaire_answers a
JOIN questionnaire_responses r ON r.id = a.response_id
JOIN questionnaires qn ON qn.id = r.questionnaire_id WHERE qn.stage = 'case'
UNION ALL
SELECT 'seeded versions', count(*) FROM questionnaire_response_versions;

COMMIT;
