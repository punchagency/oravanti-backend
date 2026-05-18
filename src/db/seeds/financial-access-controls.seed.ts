import { db } from '../../config/db';
import { financialAccessControls } from '../schema/financial-access-controls';

const defaults = [
  { accountType: 'operating' as const, role: 'admin'      as const, permission: 'full_access' as const },
  { accountType: 'operating' as const, role: 'attorney'   as const, permission: 'view_only'   as const },
  { accountType: 'operating' as const, role: 'paralegal'  as const, permission: 'no_access'   as const },
  { accountType: 'operating' as const, role: 'client'     as const, permission: 'no_access'   as const },
  { accountType: 'trust_iolta' as const, role: 'admin'    as const, permission: 'full_access' as const },
  { accountType: 'trust_iolta' as const, role: 'attorney' as const, permission: 'view_only'   as const },
  { accountType: 'trust_iolta' as const, role: 'paralegal'as const, permission: 'no_access'   as const },
  { accountType: 'trust_iolta' as const, role: 'client'   as const, permission: 'no_access'   as const },
];

async function seed() {
  console.log('Seeding financial access controls...');
  await db.insert(financialAccessControls).values(defaults).onConflictDoNothing();
  console.log('Done.');
  process.exit(0);
}

seed().catch((err) => { console.error(err); process.exit(1); });
