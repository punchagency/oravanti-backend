-- Firm edits to platform questionnaire content.
--
-- One seeded section or question serves every firm in the deployment, so a
-- firm editing it cannot write to the row. Instead the edit lands as a
-- firm-scoped copy carrying `supersedes_id`, and the merge in
-- `buildQuestionnaire` hides the original for that firm alone. Deleting the
-- copy restores the original, which is what makes the edit reversible without
-- storing a diff.
--
-- Purely additive: both columns are nullable with no default, so every
-- existing row is already correct and nothing needs backfilling.

BEGIN;

ALTER TABLE questionnaire_sections
  ADD COLUMN IF NOT EXISTS supersedes_id uuid;

ALTER TABLE questionnaire_questions
  ADD COLUMN IF NOT EXISTS supersedes_id uuid;

-- Partial indexes: the columns are null on the overwhelming majority of rows,
-- and the only query that reads them asks "is there a copy replacing this
-- one?" — which touches the non-null rows exclusively.
CREATE INDEX IF NOT EXISTS questionnaire_sections_supersedes_idx
  ON questionnaire_sections (supersedes_id)
  WHERE supersedes_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS questionnaire_questions_supersedes_idx
  ON questionnaire_questions (supersedes_id)
  WHERE supersedes_id IS NOT NULL;

-- One supersession per firm per original. Enforced in the service too, but the
-- index is what makes a concurrent double-edit impossible rather than unlikely.
CREATE UNIQUE INDEX IF NOT EXISTS questionnaire_sections_supersedes_org_unique
  ON questionnaire_sections (supersedes_id, organization_id)
  WHERE supersedes_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS questionnaire_questions_supersedes_org_unique
  ON questionnaire_questions (supersedes_id, organization_id)
  WHERE supersedes_id IS NOT NULL;

COMMIT;

-- No RLS changes. Both tables already carry the asymmetric org policy
-- (`rls_questionnaire_sections_org`, `rls_questionnaire_questions_org`), and a
-- superseding copy is an ordinary firm-owned row under it: readable by its own
-- firm, writable only by its own firm, invisible to every other.
