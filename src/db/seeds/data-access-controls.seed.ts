import { db } from '../../config/db';
import { dataAccessControls } from '../schema/data-access-controls';

const defaults = [
  // Client Personal Information (PII)
  { dataType: 'client_pii' as const, role: 'admin'     as const, permission: 'full_access' as const },
  { dataType: 'client_pii' as const, role: 'attorney'  as const, permission: 'full_access' as const },
  { dataType: 'client_pii' as const, role: 'paralegal' as const, permission: 'assigned'    as const },
  { dataType: 'client_pii' as const, role: 'client'    as const, permission: 'own_only'    as const },

  // Case Documents
  { dataType: 'case_documents' as const, role: 'admin'     as const, permission: 'full_access' as const },
  { dataType: 'case_documents' as const, role: 'attorney'  as const, permission: 'full_access' as const },
  { dataType: 'case_documents' as const, role: 'paralegal' as const, permission: 'assigned'    as const },
  { dataType: 'case_documents' as const, role: 'client'    as const, permission: 'own_only'    as const },

  // Financial Records
  { dataType: 'financial_records' as const, role: 'admin'     as const, permission: 'full_access' as const },
  { dataType: 'financial_records' as const, role: 'attorney'  as const, permission: 'view_only'   as const },
  { dataType: 'financial_records' as const, role: 'paralegal' as const, permission: 'no_access'   as const },
  { dataType: 'financial_records' as const, role: 'client'    as const, permission: 'payments'    as const },

  // Staff Information
  { dataType: 'staff_information' as const, role: 'admin'     as const, permission: 'full_access' as const },
  { dataType: 'staff_information' as const, role: 'attorney'  as const, permission: 'view_only'   as const },
  { dataType: 'staff_information' as const, role: 'paralegal' as const, permission: 'no_access'   as const },
  { dataType: 'staff_information' as const, role: 'client'    as const, permission: 'no_access'   as const },

  // AI Error Flags
  { dataType: 'ai_error_flags' as const, role: 'admin'     as const, permission: 'full_access' as const },
  { dataType: 'ai_error_flags' as const, role: 'attorney'  as const, permission: 'full_access' as const },
  { dataType: 'ai_error_flags' as const, role: 'paralegal' as const, permission: 'view_only'   as const },
  { dataType: 'ai_error_flags' as const, role: 'client'    as const, permission: 'no_access'   as const },

  // Time Tracking Data
  { dataType: 'time_tracking_data' as const, role: 'admin'     as const, permission: 'full_access' as const },
  { dataType: 'time_tracking_data' as const, role: 'attorney'  as const, permission: 'full_access' as const },
  { dataType: 'time_tracking_data' as const, role: 'paralegal' as const, permission: 'own_only'    as const },
  { dataType: 'time_tracking_data' as const, role: 'client'    as const, permission: 'no_access'   as const },
];

async function seed() {
  console.log('Seeding data access controls...');
  await db.insert(dataAccessControls).values(defaults).onConflictDoNothing();
  console.log('Done.');
  process.exit(0);
}

seed().catch((err) => { console.error(err); process.exit(1); });
