import { confirm, isCancel, note } from "@clack/prompts";
import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../client";
import {
  invitation,
  member,
  team,
  teamMember,
  user,
} from "../schema/auth-schema";
import { practiceAreas } from "../schema/practice-areas";
import { staff } from "../schema/staff";
import { staffPracticeAreas } from "../schema/staff-practice-areas";
import { teamPracticeAreas } from "../schema/team-practice-areas";

const DEMO_EMAIL_DOMAIN = "oravanti.com";

const FIRST_NAMES = [
  "Aaliyah",
  "Abdul",
  "Aditya",
  "Ahmed",
  "Aisha",
  "Ajay",
  "Akiko",
  "Alonso",
  "Amara",
  "Ananya",
  "Andre",
  "Anika",
  "Aria",
  "Arjun",
  "Asha",
  "Beatriz",
  "Carlos",
  "Camila",
  "Cecilia",
  "Chen",
  "Chidera",
  "Dae",
  "Deepa",
  "Diego",
  "Dmitri",
  "Elena",
  "Elif",
  "Emeka",
  "Esperanza",
  "Fatima",
  "Gabriela",
  "Grace",
  "Hailey",
  "Hana",
  "Hiro",
  "Idris",
  "Imani",
  "Ingrid",
  "Iris",
  "Isabel",
  "Jada",
  "Jae",
  "Jasmine",
  "Jian",
  "Jin",
  "Joaquin",
  "Juma",
  "Kai",
  "Kamala",
  "Kenji",
  "Kofi",
  "Krishna",
  "Kwame",
  "Laila",
  "Lakshmi",
  "Liam",
  "Lin",
  "Luca",
  "Luis",
  "Lydia",
  "Maeve",
  "Malik",
  "Maya",
  "Mei",
  "Mia",
  "Miguel",
  "Mina",
  "Mira",
  "Miyako",
  "Muhammad",
  "Nadia",
  "Nala",
  "Naomi",
  "Nasir",
  "Nia",
  "Noa",
  "Noor",
  "Nyla",
  "Olga",
  "Omar",
  "Onyeka",
  "Paolo",
  "Priya",
  "Qiang",
  "Rafael",
  "Rajan",
  "Rashid",
  "Rina",
  "Rosa",
  "Rumi",
  "Sakura",
  "Sami",
  "Santiago",
  "Sarah",
  "Seo",
  "Sofia",
  "Suki",
  "Tariq",
  "Tashi",
  "Thabo",
  "Tia",
  "Umar",
  "Valentina",
  "Viktor",
  "Wei",
  "Xander",
  "Yara",
  "Yuki",
  "Zara",
  "Zola",
];

const LAST_NAMES = [
  "Adebayo",
  "Aguilar",
  "Ahmed",
  "Alam",
  "Alvarez",
  "Amari",
  "Asante",
  "Banerjee",
  "Barbosa",
  "Bekele",
  "Bello",
  "Bianchi",
  "Cabrera",
  "Cardenas",
  "Carrillo",
  "Castro",
  "Chan",
  "Chao",
  "Chen",
  "Cheng",
  "Choi",
  "Chung",
  "Costa",
  "Cruz",
  "da Silva",
  "Das",
  "de la Cruz",
  "Delgado",
  "Desai",
  "Diaz",
  "Dubois",
  "Dumont",
  "Echeverri",
  "Egbuna",
  "Ekstrom",
  "El Amrani",
  "Espinoza",
  "Fernandez",
  "Ferreira",
  "Fujimoto",
  "Garcia",
  "Gomes",
  "Gonzalez",
  "Gupta",
  "Gutierrez",
  "Hassan",
  "He",
  "Hernandez",
  "Huang",
  "Igwe",
  "Ikeda",
  "Ito",
  "Ivanova",
  "Iwamoto",
  "Jabari",
  "Jafari",
  "Jain",
  "Jiang",
  "Johansson",
  "Jones",
  "Jovanovic",
  "Kahlil",
  "Kang",
  "Kaplan",
  "Karimi",
  "Kato",
  "Kaur",
  "Kawaguchi",
  "Keita",
  "Khalid",
  "Kim",
  "Klein",
  "Kobayashi",
  "Kone",
  "Kouma",
  "Krishnan",
  "Kumar",
  "Kuznetsov",
  "Kwak",
  "Lam",
  "Lara",
  "Lau",
  "Lee",
  "Li",
  "Lima",
  "Lin",
  "Liu",
  "Lopez",
  "Lund",
  "Luo",
  "Ma",
  "Mackenzie",
  "Mahfouz",
  "Maldonado",
  "Mansour",
  "Marquez",
  "Martinez",
  "Matsumoto",
  "Mendoza",
  "Mensah",
  "Miranda",
  "Miyamoto",
  "Mohan",
  "Molina",
  "Moreau",
  "Moreno",
  "Mori",
  "Moyo",
  "Mueller",
  "Murakami",
  "Mwangi",
  "Naidu",
  "Nakamura",
  "Nascimento",
  "Navarro",
  "Ndour",
  "Nguyen",
  "Nishimura",
  "Nkosi",
  "Nogueira",
  "Nunez",
  "Obinna",
  "Ochoa",
  "Okafor",
  "Okonkwo",
  "Oliveira",
  "Omar",
  "Onyango",
  "Osei",
  "Otsuka",
  "Padilla",
  "Park",
  "Patel",
  "Pena",
  "Pereira",
  "Perez",
  "Petrov",
  "Pham",
  "Phan",
  "Pinto",
  "Popov",
  "Prado",
  "Quinn",
  "Rahman",
  "Ramirez",
  "Ramos",
  "Rashid",
  "Reyes",
  "Rivera",
  "Rodriguez",
  "Romero",
  "Rostami",
  "Ruiz",
  "Saad",
  "Saito",
  "Sakamoto",
  "Salazar",
  "Sanchez",
  "Santos",
  "Sarkar",
  "Sasaki",
  "Sato",
  "Schmidt",
  "Seo",
  "Sharma",
  "Singh",
  "Sokolov",
  "Sorensen",
  "Soto",
  "Suzuki",
  "Tanaka",
  "Tang",
  "Tavares",
  "Taylor",
  "Thakur",
  "Torres",
  "Traore",
  "Tran",
  "Trinh",
  "Uchida",
  "Ueda",
  "Umarov",
  "Valdez",
  "Vargas",
  "Vasquez",
  "Vega",
  "Velasco",
  "Venegas",
  "Verma",
  "Viera",
  "Villarreal",
  "Vogel",
  "Volkov",
  "Wada",
  "Wang",
  "Watanabe",
  "Wilson",
  "Wong",
  "Xu",
  "Yamada",
  "Yamaguchi",
  "Yamamoto",
  "Yang",
  "Yeboah",
  "Yilmaz",
  "Yoshida",
  "Zhang",
  "Zhao",
  "Zheng",
  "Zhou",
];

const STAFF_STATUS_DISTRIBUTION = [
  "active",
  "active",
  "active",
  "active",
  "active",
  "active",
  "active",
  "active",
  "active",
  "active",
  "inactive",
  "inactive",
  "on_leave",
  "on_leave",
  "recertify_required",
  "pending_invitation",
  "pending_invitation",
] as const;

const ROLES = [
  "admin",
  "attorney",
  "attorney",
  "attorney",
  "paralegal",
  "paralegal",
] as const;

const TEAM_NAMES = [
  "Immigration Alpha",
  "Immigration Beta",
  "Family Law",
  "Corporate",
  "Real Estate",
  "Personal Injury",
  "Criminal Defense",
  "Employment Litigation",
  "Tax Advisory",
  "IP Litigation",
  "Bankruptcy & Restructuring",
  "Healthcare Regulatory",
  "Civil Litigation",
  "Estate Planning",
  "Environmental Compliance",
  "Business Transactions",
  "Intake & Triage",
  "Compliance & Risk",
  "Appeals",
  "Discovery Support",
];

const pick = <T>(items: readonly T[], index: number) =>
  items[index % items.length];

const range = (count: number) =>
  Array.from({ length: count }, (_, index) => index);

const pad = (value: number, width = 3) => String(value).padStart(width, "0");

export const seedStaffAndTeams = async (organizationId: string) => {
  const shouldProceed = await confirm({
    message: `Seed ~100 staff members and ~20 teams for org ${organizationId}?`,
    initialValue: false,
  });

  if (isCancel(shouldProceed) || !shouldProceed) {
    note("Cancelled.");
    return;
  }

  const suffix = `staff-${Date.now()}`;
  const staffCount = 100;
  const teamCount = 20;

  const practiceAreaRows = await db.select().from(practiceAreas);

  interface StaffEntry {
    id: string;
    userId: string | null;
    role: string | null;
    status: string;
    email: string;
  }

  const createdStaff: StaffEntry[] = [];

  for (const i of range(staffCount)) {
    const firstName = pick(FIRST_NAMES, i);
    const lastName = pick(LAST_NAMES, i);
    const role = pick(ROLES, i);
    const status = pick(STAFF_STATUS_DISTRIBUTION, i);
    const email = `${firstName.toLowerCase()}.${lastName.toLowerCase()}@${DEMO_EMAIL_DOMAIN}`;
    const userId = `seed-staff-user-${suffix}-${pad(i + 1)}`;
    const phone = `+1-555-${pad(1000 + i, 4)}`;
    const jobTitle =
      role === "admin"
        ? "Admin"
        : role === "attorney"
          ? "Attorney"
          : "Paralegal";
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - Math.floor(Math.random() * 365));
    const maxCaseload =
      role === "attorney"
        ? 10 + (i % 6) * 2
        : role === "paralegal"
          ? 15 + (i % 5) * 3
          : 7;

    const authUser =
      (
        await db
          .insert(user)
          .values({
            id: userId,
            name: `${firstName} ${lastName}`,
            email,
            emailVerified: status !== "pending_invitation",
          })
          .onConflictDoNothing()
          .returning()
      )[0] ??
      (await db.select().from(user).where(eq(user.email, email)).limit(1))[0];

    if (!authUser) continue;

    const newStaff = (
      await db
        .insert(staff)
        .values({
          organizationId,
          userId: authUser.id,
          email,
          firstName,
          lastName,
          phone,
          jobTitle,
          status,
          role,
          startDate,
          maxCaseload,
          orgEmail: email,
        })
        .onConflictDoNothing()
        .returning()
    )[0];

    if (!newStaff) {
      const existing = (
        await db
          .select()
          .from(staff)
          .where(
            and(
              eq(staff.organizationId, organizationId),
              eq(staff.email, email),
            ),
          )
          .limit(1)
      )[0];
      if (existing) {
        createdStaff.push({
          id: existing.id,
          userId: existing.userId,
          role: existing.role,
          status,
          email,
        });
      }
      continue;
    }

    await db
      .insert(member)
      .values({
        id: randomUUID(),
        organizationId,
        userId: authUser.id,
        role,
        createdAt: new Date(),
      })
      .onConflictDoNothing();

    createdStaff.push({
      id: newStaff.id,
      userId: newStaff.userId,
      role: newStaff.role,
      status,
      email,
    });

    const practiceCount = 1 + (i % 3);
    for (const p of range(practiceCount)) {
      const paIdx = (i + p) % practiceAreaRows.length;
      await db
        .insert(staffPracticeAreas)
        .values({
          staffId: newStaff.id,
          practiceAreaId: practiceAreaRows[paIdx].id,
        })
        .onConflictDoNothing();
    }
  }

  const createdTeams: Array<{ id: string }> = [];

  for (const i of range(teamCount)) {
    const teamName = `${pick(TEAM_NAMES, i)}`;
    const teamId = `seed-team-${suffix}-${pad(i + 1)}`;

    const existingTeam = (
      await db.select().from(team).where(eq(team.id, teamId)).limit(1)
    )[0];
    if (existingTeam) {
      createdTeams.push({ id: existingTeam.id });
      continue;
    }

    const leadStaff = createdStaff[i % createdStaff.length];

    await db.insert(team).values({
      id: teamId,
      name: teamName,
      organizationId,
      createdAt: new Date(),
      leadId: leadStaff.userId,
      description: `Handles ${pick(TEAM_NAMES, i).toLowerCase()} matters.`,
      maxCaseload: 40 + (i % 5) * 5,
      workloadPercentage: 30 + (i % 7) * 5,
      status: i % 8 === 0 ? "full" : i % 9 === 0 ? "overloaded" : "available",
      activeCases: 3 + (i % 10),
    });

    if (leadStaff.userId) {
      await db
        .insert(teamMember)
        .values({
          id: randomUUID(),
          teamId,
          userId: leadStaff.userId,
          createdAt: new Date(),
        })
        .onConflictDoNothing();
    }

    createdTeams.push({ id: teamId });

    const paIdx = i % practiceAreaRows.length;
    await db
      .insert(teamPracticeAreas)
      .values({
        teamId,
        practiceAreaId: practiceAreaRows[paIdx].id,
      })
      .onConflictDoNothing();
  }

  const staffTeamCount = new Map<string, number>();

  for (const [staffIdx, entry] of createdStaff.entries()) {
    const teamId = createdTeams[staffIdx % createdTeams.length].id;
    if (entry.userId) {
      await db
        .insert(teamMember)
        .values({
          id: randomUUID(),
          teamId,
          userId: entry.userId,
          createdAt: new Date(),
        })
        .onConflictDoNothing();
      staffTeamCount.set(entry.id, (staffTeamCount.get(entry.id) ?? 0) + 1);
    }
  }

  for (const [i, teamEntry] of createdTeams.entries()) {
    const extrasPerTeam = 3 + (i % 4);
    let extras = 0;
    for (const entry of createdStaff) {
      if (extras >= extrasPerTeam) break;
      if (!entry.userId) continue;
      const count = staffTeamCount.get(entry.id) ?? 0;
      if (count >= 3) continue;
      await db
        .insert(teamMember)
        .values({
          id: randomUUID(),
          teamId: teamEntry.id,
          userId: entry.userId,
          createdAt: new Date(),
        })
        .onConflictDoNothing();
      staffTeamCount.set(entry.id, count + 1);
      extras++;
    }
  }

  const pendingStaff = createdStaff.filter(
    (s) => s.status === "pending_invitation",
  );
  const inviterId = createdStaff[0]?.userId;
  let invitationCount = 0;

  for (const entry of pendingStaff) {
    if (!entry.userId) continue;
    const teamId =
      createdTeams.length > 0
        ? createdTeams[invitationCount % createdTeams.length].id
        : undefined;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    await db
      .insert(invitation)
      .values({
        id: randomUUID(),
        organizationId,
        email: entry.email,
        role: entry.role ?? undefined,
        teamId,
        status: "pending",
        expiresAt,
        inviterId: inviterId ?? createdStaff[0]?.id ?? "",
      })
      .onConflictDoNothing();
    invitationCount++;
  }

  note(
    `Seeded ${createdStaff.length} staff members, ${createdTeams.length} teams, ${invitationCount} invitations for org ${organizationId}.`,
    "Staff, Teams & Invitations",
  );
};
