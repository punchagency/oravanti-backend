-- Add workflow event types to the case_event_type enum
ALTER TYPE case_event_type ADD VALUE IF NOT EXISTS 'workflow_initialized';
ALTER TYPE case_event_type ADD VALUE IF NOT EXISTS 'module_activated';
ALTER TYPE case_event_type ADD VALUE IF NOT EXISTS 'step_assigned';
ALTER TYPE case_event_type ADD VALUE IF NOT EXISTS 'step_completed';
ALTER TYPE case_event_type ADD VALUE IF NOT EXISTS 'step_submitted_for_review';
ALTER TYPE case_event_type ADD VALUE IF NOT EXISTS 'step_approved';
ALTER TYPE case_event_type ADD VALUE IF NOT EXISTS 'step_rejected';
