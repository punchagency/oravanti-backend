-- ============================================================================
-- Consolidate the questionnaire tables
-- ============================================================================
--
-- Six tables become three, and `questionnaire_answers.question_id` becomes a
-- real foreign key for the first time.
--
--   case_type_questionnaire_sections  ─┐
--   firm_questionnaire_sections       ─┴─→  questionnaire_sections
--   case_type_questionnaire_questions ─┐
--   firm_questionnaire_questions      ─┴─→  questionnaire_questions
--   case_type_questionnaire_logic_rules ─┐
--   firm_questionnaire_logic_rules      ─┴─→  questionnaire_logic_rules
--   case_type_questionnaires            ──→  questionnaires
--
-- The tier a row belonged to becomes a `scope` column (`system` | `firm` |
-- `case`), and `organization_id` becomes nullable — NULL is the platform's own
-- content, which every firm reads and none may write. `questionnaires` also
-- gains a `stage` (`intake` | `case`): everything that exists today is intake.
--
-- Run inside one transaction. If any step fails, nothing is applied.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f scripts/migrations/consolidate-questionnaires.sql
--
-- Afterwards, re-apply the RLS policies (drizzle emits them, but only for
-- tables it created — these are created here):
--
--   npm run security:baseline
--
-- ============================================================================

BEGIN;

-- ─── 1. New enums ───────────────────────────────────────────────────────────

CREATE TYPE questionnaire_stage AS ENUM ('intake', 'case');
CREATE TYPE questionnaire_scope AS ENUM ('system', 'firm', 'case');

-- ─── 2. questionnaires ──────────────────────────────────────────────────────
--
-- A rename rather than a create-and-copy, so every id survives and the sends,
-- responses and answers pointing at them stay valid.

ALTER TABLE case_type_questionnaires RENAME TO questionnaires;

ALTER TABLE questionnaires
  ADD COLUMN stage questionnaire_stage NOT NULL DEFAULT 'intake';

-- One questionnaire per case type becomes one per (case type, stage).
ALTER TABLE questionnaires DROP CONSTRAINT IF EXISTS case_type_questionnaires_case_type_id_unique;
ALTER TABLE questionnaires
  ADD CONSTRAINT questionnaires_case_type_stage_unique UNIQUE (case_type_id, stage);

CREATE INDEX IF NOT EXISTS questionnaires_case_type_idx ON questionnaires (case_type_id);

-- ─── 3. questionnaire_sections ──────────────────────────────────────────────

CREATE TABLE questionnaire_sections (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  questionnaire_id uuid NOT NULL REFERENCES questionnaires (id) ON DELETE CASCADE,
  scope            questionnaire_scope NOT NULL,
  organization_id  text REFERENCES organization (id),
  case_id          uuid REFERENCES cases (id) ON DELETE CASCADE,
  title            text NOT NULL,
  description      text,
  order_index      integer NOT NULL,
  created_at       timestamp NOT NULL DEFAULT now(),
  updated_at       timestamp NOT NULL DEFAULT now()
);

-- System sections keep their ids, so existing questions and answers still line
-- up without a lookup table.
INSERT INTO questionnaire_sections
  (id, questionnaire_id, scope, organization_id, case_id, title, description, order_index, created_at, updated_at)
SELECT
  s.id, s.questionnaire_id, 'system', NULL, NULL,
  s.title, s.description, s.order_index, s.created_at, s.created_at
FROM case_type_questionnaire_sections s;

-- Firm sections were keyed on (organization, case type) rather than on a
-- questionnaire, so they have to find their questionnaire by that pair. A firm
-- section for a case type with no questionnaire has nothing to attach to and is
-- dropped; the COUNT below reports how many, and it should be zero.
INSERT INTO questionnaire_sections
  (id, questionnaire_id, scope, organization_id, case_id, title, description, order_index, created_at, updated_at)
SELECT
  f.id, q.id, 'firm', f.organization_id, NULL,
  f.title, f.description, f.order_index, f.created_at, f.updated_at
FROM firm_questionnaire_sections f
JOIN questionnaires q
  ON q.case_type_id = f.case_type_id AND q.stage = 'intake';

CREATE INDEX questionnaire_sections_questionnaire_idx ON questionnaire_sections (questionnaire_id);
CREATE INDEX questionnaire_sections_org_idx           ON questionnaire_sections (organization_id);
CREATE INDEX questionnaire_sections_case_idx          ON questionnaire_sections (case_id);

-- ─── 4. questionnaire_questions ─────────────────────────────────────────────

CREATE TABLE questionnaire_questions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  questionnaire_id uuid NOT NULL REFERENCES questionnaires (id) ON DELETE CASCADE,
  section_id       uuid NOT NULL REFERENCES questionnaire_sections (id) ON DELETE CASCADE,
  scope            questionnaire_scope NOT NULL,
  organization_id  text REFERENCES organization (id),
  case_id          uuid REFERENCES cases (id) ON DELETE CASCADE,
  field_key        text,
  label            text NOT NULL,
  description      text,
  type             questionnaire_question_type NOT NULL,
  order_index      integer NOT NULL,
  is_required      boolean NOT NULL DEFAULT false,
  config           jsonb NOT NULL DEFAULT '{}',
  created_at       timestamp NOT NULL DEFAULT now(),
  updated_at       timestamp NOT NULL DEFAULT now()
);

INSERT INTO questionnaire_questions
  (id, questionnaire_id, section_id, scope, organization_id, case_id,
   field_key, label, description, type, order_index, is_required, config, created_at, updated_at)
SELECT
  q.id, q.questionnaire_id, q.section_id, 'system', NULL, NULL,
  NULL, q.label, q.description, q.type, q.order_index, q.is_required, q.config,
  q.created_at, q.created_at
FROM case_type_questionnaire_questions q;

-- A firm question attached to EITHER a system section or a firm section; both
-- now live in one table, so `coalesce` collapses the two columns into the one
-- foreign key. Rows attached to neither were never valid and are skipped by the
-- NOT NULL filter.
INSERT INTO questionnaire_questions
  (id, questionnaire_id, section_id, scope, organization_id, case_id,
   field_key, label, description, type, order_index, is_required, config, created_at, updated_at)
SELECT
  f.id,
  s.questionnaire_id,
  coalesce(f.system_section_id, f.firm_section_id),
  'firm',
  f.organization_id,
  NULL,
  NULL, f.label, f.description, f.type, f.order_index, f.is_required, f.config,
  f.created_at, f.updated_at
FROM firm_questionnaire_questions f
JOIN questionnaire_sections s
  ON s.id = coalesce(f.system_section_id, f.firm_section_id)
WHERE coalesce(f.system_section_id, f.firm_section_id) IS NOT NULL;

CREATE INDEX questionnaire_questions_questionnaire_idx ON questionnaire_questions (questionnaire_id);
CREATE INDEX questionnaire_questions_section_idx       ON questionnaire_questions (section_id);
CREATE INDEX questionnaire_questions_org_idx           ON questionnaire_questions (organization_id);
CREATE INDEX questionnaire_questions_case_idx          ON questionnaire_questions (case_id);
CREATE INDEX questionnaire_questions_field_key_idx     ON questionnaire_questions (field_key);

-- ─── 5. questionnaire_logic_rules ───────────────────────────────────────────

CREATE TABLE questionnaire_logic_rules (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  questionnaire_id   uuid NOT NULL REFERENCES questionnaires (id) ON DELETE CASCADE,
  scope              questionnaire_scope NOT NULL,
  organization_id    text REFERENCES organization (id),
  case_id            uuid REFERENCES cases (id) ON DELETE CASCADE,
  source_question_id uuid NOT NULL REFERENCES questionnaire_questions (id) ON DELETE CASCADE,
  target_question_id uuid REFERENCES questionnaire_questions (id) ON DELETE CASCADE,
  target_section_id  uuid REFERENCES questionnaire_sections (id) ON DELETE CASCADE,
  condition          jsonb NOT NULL DEFAULT '{}',
  action_type        questionnaire_logic_action NOT NULL,
  action             jsonb NOT NULL DEFAULT '{}',
  priority           integer NOT NULL DEFAULT 0,
  created_at         timestamp NOT NULL DEFAULT now(),
  updated_at         timestamp NOT NULL DEFAULT now()
);

INSERT INTO questionnaire_logic_rules
  (id, questionnaire_id, scope, organization_id, case_id,
   source_question_id, target_question_id, target_section_id,
   condition, action_type, action, priority, created_at, updated_at)
SELECT
  r.id, r.questionnaire_id, 'system', NULL, NULL,
  r.source_question_id, NULL, NULL,
  r.condition, r.action_type, r.action, r.priority, r.created_at, r.updated_at
FROM case_type_questionnaire_logic_rules r
WHERE EXISTS (SELECT 1 FROM questionnaire_questions qq WHERE qq.id = r.source_question_id);

-- The firm rule table carried `target_question_source` + an unconstrained
-- `target_question_id`. With one questions table the discriminator is dead, and
-- the target only survives if it resolves to a real question — anything that
-- does not was already a dangling pointer.
INSERT INTO questionnaire_logic_rules
  (id, questionnaire_id, scope, organization_id, case_id,
   source_question_id, target_question_id, target_section_id,
   condition, action_type, action, priority, created_at, updated_at)
SELECT
  r.id, s.questionnaire_id, 'firm', r.organization_id, NULL,
  r.source_question_id,
  (SELECT qq.id FROM questionnaire_questions qq WHERE qq.id = r.target_question_id),
  NULL,
  r.condition, r.action_type, r.action, r.priority, r.created_at, r.updated_at
FROM firm_questionnaire_logic_rules r
JOIN questionnaire_questions sq ON sq.id = r.source_question_id
JOIN questionnaire_sections  s  ON s.id  = sq.section_id;

CREATE INDEX questionnaire_logic_rules_questionnaire_idx ON questionnaire_logic_rules (questionnaire_id);
CREATE INDEX questionnaire_logic_rules_source_idx        ON questionnaire_logic_rules (source_question_id);

-- ─── 6. Sends, responses, answers ───────────────────────────────────────────

ALTER TABLE questionnaire_sends
  RENAME COLUMN case_type_questionnaire_id TO questionnaire_id;

CREATE INDEX IF NOT EXISTS questionnaire_sends_case_idx ON questionnaire_sends (case_id);

ALTER TABLE questionnaire_responses
  RENAME COLUMN case_type_questionnaire_id TO questionnaire_id;

-- A response no longer requires a send: staff can fill a case questionnaire
-- in-house, on a call or from documents already on file.
ALTER TABLE questionnaire_responses
  ALTER COLUMN questionnaire_send_id DROP NOT NULL;

ALTER TABLE questionnaire_responses
  ADD COLUMN filled_by_id uuid REFERENCES staff (id);

-- `current_section_ref` was a jsonb `{ source, id }` because the id alone could
-- not say which table it meant. It can now, so it becomes a foreign key and the
-- id is lifted out of the json.
ALTER TABLE questionnaire_responses
  ADD COLUMN current_section_id uuid REFERENCES questionnaire_sections (id) ON DELETE SET NULL;

UPDATE questionnaire_responses r
SET current_section_id = (r.current_section_ref ->> 'id')::uuid
WHERE r.current_section_ref ? 'id'
  AND EXISTS (
    SELECT 1 FROM questionnaire_sections s
    WHERE s.id = (r.current_section_ref ->> 'id')::uuid
  );

ALTER TABLE questionnaire_responses DROP COLUMN current_section_ref;

CREATE INDEX IF NOT EXISTS questionnaire_responses_case_idx ON questionnaire_responses (case_id);

-- The point of the whole exercise: an answer's question_id becomes a foreign
-- key. Any answer whose question no longer exists is deleted first — it could
-- never have been rendered, since nothing knew what it was answering.
DELETE FROM questionnaire_answers a
WHERE NOT EXISTS (SELECT 1 FROM questionnaire_questions q WHERE q.id = a.question_id);

ALTER TABLE questionnaire_answers DROP COLUMN question_source;
ALTER TABLE questionnaire_answers
  ADD CONSTRAINT questionnaire_answers_question_id_fk
  FOREIGN KEY (question_id) REFERENCES questionnaire_questions (id) ON DELETE CASCADE;

DELETE FROM questionnaire_response_files f
WHERE NOT EXISTS (SELECT 1 FROM questionnaire_questions q WHERE q.id = f.question_id);

ALTER TABLE questionnaire_response_files DROP COLUMN question_source;
ALTER TABLE questionnaire_response_files
  ADD CONSTRAINT questionnaire_response_files_question_id_fk
  FOREIGN KEY (question_id) REFERENCES questionnaire_questions (id) ON DELETE CASCADE;

-- ─── 7. Drop the old tables ─────────────────────────────────────────────────

DROP TABLE firm_questionnaire_logic_rules;
DROP TABLE firm_questionnaire_questions;
DROP TABLE firm_questionnaire_sections;
DROP TABLE case_type_questionnaire_logic_rules;
DROP TABLE case_type_questionnaire_questions;
DROP TABLE case_type_questionnaire_sections;

DROP TYPE question_source;

-- ─── 8. Row-level security ──────────────────────────────────────────────────
--
-- Drizzle emits policies for tables it creates; these were created here, so
-- they are declared here too. `using` admits a NULL organization_id and
-- `with check` does not — every firm reads the platform's questions, no firm
-- writes them. See the section note in src/db/schema/rls.ts.

ALTER TABLE questionnaire_sections    ENABLE ROW LEVEL SECURITY;
ALTER TABLE questionnaire_questions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE questionnaire_logic_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY rls_questionnaire_sections_org ON questionnaire_sections
  AS PERMISSIVE FOR ALL
  USING (organization_id IS NULL OR organization_id = get_current_organization_id())
  WITH CHECK (organization_id = get_current_organization_id());

CREATE POLICY rls_questionnaire_questions_org ON questionnaire_questions
  AS PERMISSIVE FOR ALL
  USING (organization_id IS NULL OR organization_id = get_current_organization_id())
  WITH CHECK (organization_id = get_current_organization_id());

CREATE POLICY rls_questionnaire_logic_rules_org ON questionnaire_logic_rules
  AS PERMISSIVE FOR ALL
  USING (organization_id IS NULL OR organization_id = get_current_organization_id())
  WITH CHECK (organization_id = get_current_organization_id());

-- ─── 9. Report ──────────────────────────────────────────────────────────────

DO $$
DECLARE
  n_questionnaires bigint;
  n_sections       bigint;
  n_questions      bigint;
  n_rules          bigint;
  n_answers        bigint;
BEGIN
  SELECT count(*) INTO n_questionnaires FROM questionnaires;
  SELECT count(*) INTO n_sections       FROM questionnaire_sections;
  SELECT count(*) INTO n_questions      FROM questionnaire_questions;
  SELECT count(*) INTO n_rules          FROM questionnaire_logic_rules;
  SELECT count(*) INTO n_answers        FROM questionnaire_answers;

  RAISE NOTICE 'questionnaires: %, sections: %, questions: %, logic rules: %, answers: %',
    n_questionnaires, n_sections, n_questions, n_rules, n_answers;
END $$;

COMMIT;
