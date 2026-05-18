import { db } from '../../config/db';
import { certifications } from '../schema/certifications';

const defaults = [
  // Basic
  { code: 'ILF',   name: 'Immigration Law Fundamentals',        level: 'basic'        as const },
  { code: 'LEC',   name: 'Legal Ethics & Compliance',           level: 'basic'        as const },
  // Intermediate
  { code: 'I485FP', name: 'I-485 Form Processing',              level: 'intermediate' as const },
  { code: 'I130PF', name: 'I-130 Petition Filing',              level: 'intermediate' as const },
  { code: 'I129NP', name: 'I-129 Nonimmigrant Worker Petition', level: 'intermediate' as const },
  { code: 'CCCM',  name: 'Client Communication & Case Management', level: 'intermediate' as const },
  // Advanced
  { code: 'I140IP', name: 'I-140 Immigrant Petition',           level: 'advanced'     as const },
  { code: 'AAP',   name: 'Asylum Application Procedures',       level: 'advanced'     as const },
  { code: 'H1BVP', name: 'H-1B Visa Processing',               level: 'advanced'     as const },
  { code: 'NAC',   name: 'Naturalization & Citizenship',        level: 'advanced'     as const },
  // Expert
  { code: 'EBVP',  name: 'Employment-Based Visa Processing',    level: 'expert'       as const },
  { code: 'UEFC',  name: 'USCIS Electronic Filing Certified',   level: 'expert'       as const },
];

async function seed() {
  console.log('Seeding certifications...');
  await db.insert(certifications).values(defaults).onConflictDoNothing();
  console.log('Done.');
  process.exit(0);
}

seed().catch((err) => { console.error(err); process.exit(1); });
