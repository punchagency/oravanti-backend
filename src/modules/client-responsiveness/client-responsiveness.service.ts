import { and, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { cases } from "../../db/schema/cases";
import { clientContacts } from "../../db/schema/client-contacts";
import { clientRequests } from "../../db/schema/client-requests";
import { clients } from "../../db/schema/clients";


// ─── Constants ────────────────────────────────────────────────────────────────

const TERMINATION_DAYS = 135;

// ─── Types ────────────────────────────────────────────────────────────────────

type ClientSummary = {
  id: string;
  displayName: string;
  email: string | null;
  phone: string | null;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const daysSince = (dateStr: string): number => {
  const diff = Date.now() - new Date(dateStr).getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
};

const computeStatus = (days: number) => {
  if (days <= 29) return "responsive";
  if (days <= 59) return "at_risk";
  if (days <= 90) return "unresponsive";
  return "critical";
};

const computeRecommendedAction = (status: string, days: number): string => {
  switch (status) {
    case "responsive":
      return "None - client is responsive";
    case "at_risk":
      return "Send a follow-up email to the client";
    case "unresponsive":
      return "Contact client immediately by phone";
    case "critical":
      return days >= TERMINATION_DAYS
        ? `IMMEDIATE: Prepare termination letter (${days} days elapsed)`
        : `URGENT: Client approaching termination — ${TERMINATION_DAYS - days} days remaining`;
    default:
      return "None";
  }
};

// ─── Build client record ──────────────────────────────────────────────────────

const buildClientRecord = (
  client: ClientSummary,
  pendingRequests: {
    id: string;
    clientId: string;
    caseId: string;
    description: string;
    requestedAt: string;
    status: "pending" | "fulfilled";
    caseNumber: string | null;
  }[],
) => {
  if (pendingRequests.length === 0) {
    return {
      client: {
        id: client.id,
        displayName: client.displayName,
        email: client.email,
        phone: client.phone,
      },
      lastContactDate: null,
      daysSinceContact: null,
      daysToTermination: null,
      status: "responsive" as const,
      pendingRequests: [],
      recommendedAction: "None - client is responsive",
    };
  }

  const sorted = [...pendingRequests].sort(
    (a, b) =>
      new Date(a.requestedAt).getTime() - new Date(b.requestedAt).getTime(),
  );
  const oldest = sorted[0];
  const days = daysSince(oldest.requestedAt);
  const status = computeStatus(days);
  const daysToTerm = days >= TERMINATION_DAYS ? null : TERMINATION_DAYS - days;

  const grouped = sorted.reduce<
    Record<
      string,
      {
        requestedAt: string;
        caseId: string;
        caseNumber: string | null;
        items: { id: string; description: string }[];
      }
    >
  >((acc, r) => {
    if (!acc[r.requestedAt]) {
      acc[r.requestedAt] = {
        requestedAt: r.requestedAt,
        caseId: r.caseId,
        caseNumber: r.caseNumber,
        items: [],
      };
    }
    acc[r.requestedAt].items.push({ id: r.id, description: r.description });
    return acc;
  }, {});

  return {
    client: {
      id: client.id,
      displayName: client.displayName,
      email: client.email,
      phone: client.phone,
    },
    lastContactDate: oldest.requestedAt,
    daysSinceContact: days,
    daysToTermination: daysToTerm,
    status,
    pendingRequests: Object.values(grouped),
    recommendedAction: computeRecommendedAction(status, days),
  };
};

// ─── Fetch clients with primary contact ──────────────────────────────────────

const fetchClientsWithContact = async (
  organizationId: string,
): Promise<ClientSummary[]> => {
  return db
    .select({
      id: clients.id,
      displayName: clients.displayName,
      email: clientContacts.email,
      phone: clientContacts.phone,
    })
    .from(clients)
    .leftJoin(
      clientContacts,
      and(
        eq(clientContacts.clientId, clients.id),
        eq(clientContacts.type, 'primary_client'),
      )
    )
    .where(eq(clients.organizationId, organizationId));
};

// ─── Stats ────────────────────────────────────────────────────────────────────

export const getStats = async (organizationId: string) => {
  const allClients = await db
    .select({ id: clients.id })
    .from(clients)
    .where(eq(clients.organizationId, organizationId));

  const pending = await db
    .select()
    .from(clientRequests)
    .where(
      and(
        eq(clientRequests.organizationId, organizationId),
        eq(clientRequests.status, "pending"),
      ),
    );

  const counts = { responsive: 0, at_risk: 0, unresponsive: 0, critical: 0 };

  for (const client of allClients) {
    const clientPending = pending.filter((r) => r.clientId === client.id);
    if (clientPending.length === 0) {
      counts.responsive++;
      continue;
    }

    const oldest = clientPending.reduce((min, r) =>
      new Date(r.requestedAt) < new Date(min.requestedAt) ? r : min,
    );
    const status = computeStatus(
      daysSince(oldest.requestedAt),
    ) as keyof typeof counts;
    counts[status]++;
  }

  return counts;
};

// ─── List ─────────────────────────────────────────────────────────────────────

export const getAllClientResponsiveness = async (
  organizationId: string,
  filters?: { filter?: string; search?: string },
) => {
  const allClients = await fetchClientsWithContact(organizationId);

  const pendingRows = await db
    .select({
      id: clientRequests.id,
      clientId: clientRequests.clientId,
      caseId: clientRequests.caseId,
      description: clientRequests.description,
      requestedAt: clientRequests.requestedAt,
      status: clientRequests.status,
      caseNumber: cases.caseNumber,
    })
    .from(clientRequests)
    .leftJoin(cases, eq(cases.id, clientRequests.caseId))
    .where(
      and(
        eq(clientRequests.organizationId, organizationId),
        eq(clientRequests.status, "pending"),
      ),
    );

  const records = allClients.map((client) => {
    const clientPending = pendingRows.filter((r) => r.clientId === client.id);
    return buildClientRecord(client, clientPending);
  });

  return records.filter((r) => {
    if (
      filters?.filter &&
      filters.filter !== "all" &&
      r.status !== filters.filter
    )
      return false;
    if (filters?.search) {
      const q = filters.search.toLowerCase();
      const name = r.client.displayName.toLowerCase();
      const caseNum = r.pendingRequests[0]?.caseNumber?.toLowerCase() ?? "";
      if (!name.includes(q) && !caseNum.includes(q)) return false;
    }
    return true;
  });
};

// ─── Add requests (batch) ─────────────────────────────────────────────────────

export const addRequests = async (
  clientId: string,
  organizationId: string,
  data: { caseId: string; items: string[]; requestedAt?: string },
) => {
  const requestedAt =
    data.requestedAt ?? new Date().toISOString().split("T")[0];

  const rows = data.items.map((description) => ({
    organizationId,
    clientId,
    caseId: data.caseId,
    description,
    requestedAt,
  }));

  return db.insert(clientRequests).values(rows).returning();
};

// ─── Fulfill request ──────────────────────────────────────────────────────────

export const fulfillRequest = async (requestId: string, organizationId: string) => {
  const [updated] = await db
    .update(clientRequests)
    .set({ status: "fulfilled", updatedAt: new Date() })
    .where(
      and(eq(clientRequests.id, requestId), eq(clientRequests.organizationId, organizationId)),
    )
    .returning();

  return updated ?? null;
};

// ─── Generate termination letter data ────────────────────────────────────────

export const getTerminationLetterData = async (
  clientId: string,
  organizationId: string,
) => {
  const [client] = await db
    .select({
      id: clients.id,
      displayName: clients.displayName,
      email: clientContacts.email,
      phone: clientContacts.phone,
    })
    .from(clients)
    .leftJoin(
      clientContacts,
      and(
        eq(clientContacts.clientId, clients.id),
        eq(clientContacts.type, 'primary_client'),
      ),
    )
    .where(and(eq(clients.id, clientId), eq(clients.organizationId, organizationId)));

  if (!client) return null;

  const pending = await db
    .select({
      id: clientRequests.id,
      description: clientRequests.description,
      requestedAt: clientRequests.requestedAt,
      caseNumber: cases.caseNumber,
      caseTypeId: cases.caseTypeId,
    })
    .from(clientRequests)
    .leftJoin(cases, eq(cases.id, clientRequests.caseId))
    .where(
      and(
        eq(clientRequests.organizationId, organizationId),
        eq(clientRequests.clientId, clientId),
        eq(clientRequests.status, "pending"),
      ),
    );

  const oldest =
    pending.length > 0
      ? pending.reduce((min, r) =>
          new Date(r.requestedAt) < new Date(min.requestedAt) ? r : min,
        )
      : null;
  const days = oldest ? daysSince(oldest.requestedAt) : 0;

  return {
    generatedAt: new Date().toISOString(),
    client: {
      id: client.id,
      displayName: client.displayName,
      email: client.email,
      phone: client.phone,
    },
    daysSinceContact: days,
    pendingRequests: pending,
  };
};

// ─── Export report ────────────────────────────────────────────────────────────

export const exportClientReport = async (clientId: string, organizationId: string) => {
  const [client] = await db
    .select({
      id: clients.id,
      displayName: clients.displayName,
      email: clientContacts.email,
      phone: clientContacts.phone,
    })
    .from(clients)
    .leftJoin(
      clientContacts,
      and(
        eq(clientContacts.clientId, clients.id),
        eq(clientContacts.type, 'primary_client'),
      ),
    )
    .where(and(eq(clients.id, clientId), eq(clients.organizationId, organizationId)));

  if (!client) return null;

  const allRequests = await db
    .select({
      id: clientRequests.id,
      description: clientRequests.description,
      requestedAt: clientRequests.requestedAt,
      status: clientRequests.status,
      caseNumber: cases.caseNumber,
      caseTypeId: cases.caseTypeId,
    })
    .from(clientRequests)
    .leftJoin(cases, eq(cases.id, clientRequests.caseId))
    .where(
      and(
        eq(clientRequests.organizationId, organizationId),
        eq(clientRequests.clientId, clientId),
      ),
    );

  const pending = allRequests.filter((r) => r.status === "pending");
  const oldest =
    pending.length > 0
      ? pending.reduce((min, r) =>
          new Date(r.requestedAt) < new Date(min.requestedAt) ? r : min,
        )
      : null;
  const days = oldest ? daysSince(oldest.requestedAt) : 0;
  const status = pending.length > 0 ? computeStatus(days) : "responsive";

  return {
    exportedAt: new Date().toISOString(),
    client: {
      id: client.id,
      displayName: client.displayName,
      email: client.email,
      phone: client.phone,
    },
    status,
    daysSinceContact: oldest ? days : null,
    daysToTermination:
      oldest && days < TERMINATION_DAYS ? TERMINATION_DAYS - days : null,
    recommendedAction: computeRecommendedAction(status, days),
    allRequests,
  };
};

export class ClientResponsivenessService {
  getStats = getStats;
  getAllClientResponsiveness = getAllClientResponsiveness;
  addRequests = addRequests;
  fulfillRequest = fulfillRequest;
  getTerminationLetterData = getTerminationLetterData;
  exportClientReport = exportClientReport;
}
