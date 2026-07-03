import { and, asc, eq, ilike, inArray } from "drizzle-orm";
import { db } from "../../db/client";
import { firmPracticeAreas } from "../../db/schema/firm-practice-areas";
import { practiceAreaCaseTypes } from "../../db/schema/practice-area-case-types";
import { practiceAreaSubcategories } from "../../db/schema/practice-area-subcategories";
import { practiceAreas } from "../../db/schema/practice-areas";
import {
  SubscriptionStatus,
  subscriptions,
} from "../../db/schema/subscriptions";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../utils/error/app-error";

const BILLING_CYCLES = ["monthly", "annual"] as const;
type BillingCycle = (typeof BILLING_CYCLES)[number];

type PracticeAreaFilters = {
  search?: string;
};

type SubscriptionInput = {
  practiceAreaId?: string;
  billingCycle?: string;
  startsAt?: string;
  expiresAt?: string | null;
  paymentProvider?: string;
  providerSubscriptionId?: string | null;
};

type CreateSubscriptionsBody = {
  subscriptions?: SubscriptionInput[];
  practiceAreaIds?: string[];
  billingCycle?: string;
  startsAt?: string;
  expiresAt?: string | null;
  paymentProvider?: string;
  providerSubscriptionId?: string | null;
};

type CancelSubscriptionsBody = {
  subscriptionIds?: string[];
  practiceAreaIds?: string[];
};

const normalizeSearch = (search?: string) => search?.trim() || undefined;

const assertBillingCycle = (billingCycle?: string): BillingCycle => {
  if (!billingCycle || !BILLING_CYCLES.includes(billingCycle as BillingCycle)) {
    throw new BadRequestError("billingCycle must be monthly or annual");
  }

  return billingCycle as BillingCycle;
};

const parseOptionalDate = (value: string | null | undefined, field: string) => {
  if (value === null || value === undefined) return null;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestError(`${field} must be a valid date`);
  }

  return date;
};

const uniqueIds = (ids: string[]) => {
  const cleanedIds = ids.map((id) => id.trim()).filter(Boolean);
  return [...new Set(cleanedIds)];
};

const getPracticeAreaWhere = (filters?: PracticeAreaFilters) => {
  const search = normalizeSearch(filters?.search);
  return search ? ilike(practiceAreas.name, `%${search}%`) : undefined;
};

const getSubcategoriesByPracticeArea = async (practiceAreaIds: string[]) => {
  if (!practiceAreaIds.length) return new Map<string, unknown[]>();

  const subcategoryRows = await db
    .select({
      id: practiceAreaSubcategories.id,
      practiceAreaId: practiceAreaSubcategories.practiceAreaId,
      code: practiceAreaSubcategories.code,
      name: practiceAreaSubcategories.name,
      createdAt: practiceAreaSubcategories.createdAt,
      updatedAt: practiceAreaSubcategories.updatedAt,
    })
    .from(practiceAreaSubcategories)
    .where(inArray(practiceAreaSubcategories.practiceAreaId, practiceAreaIds))
    .orderBy(asc(practiceAreaSubcategories.name));

  if (!subcategoryRows.length) return new Map<string, unknown[]>();

  const caseTypeRows = await db
    .select({
      id: practiceAreaCaseTypes.id,
      subcategoryId: practiceAreaCaseTypes.subcategoryId,
      code: practiceAreaCaseTypes.code,
      name: practiceAreaCaseTypes.name,
      caseNumberPrefix: practiceAreaCaseTypes.caseNumberPrefix,
      jurisdiction: practiceAreaCaseTypes.jurisdiction,
      createdAt: practiceAreaCaseTypes.createdAt,
      updatedAt: practiceAreaCaseTypes.updatedAt,
    })
    .from(practiceAreaCaseTypes)
    .where(
      inArray(
        practiceAreaCaseTypes.subcategoryId,
        subcategoryRows.map((subcategory) => subcategory.id),
      ),
    )
    .orderBy(asc(practiceAreaCaseTypes.name));

  const caseTypesBySubcategory = caseTypeRows.reduce((acc, row) => {
    const caseTypes = acc.get(row.subcategoryId) ?? [];
    caseTypes.push({
      id: row.id,
      code: row.code,
      name: row.name,
      caseNumberPrefix: row.caseNumberPrefix,
      jurisdiction: row.jurisdiction,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
    acc.set(row.subcategoryId, caseTypes);
    return acc;
  }, new Map<string, unknown[]>());

  return subcategoryRows.reduce((acc, row) => {
    const subcategories = acc.get(row.practiceAreaId) ?? [];
    subcategories.push({
      id: row.id,
      code: row.code,
      name: row.name,
      caseTypes: caseTypesBySubcategory.get(row.id) ?? [],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
    acc.set(row.practiceAreaId, subcategories);
    return acc;
  }, new Map<string, unknown[]>());
};

const normalizeSubscriptionInputs = (body: CreateSubscriptionsBody) => {
  const topLevelPaymentProvider = body.paymentProvider || "demo";
  const topLevelBillingCycle = body.billingCycle;
  const topLevelStartsAt = body.startsAt;
  const topLevelExpiresAt = body.expiresAt;
  const topLevelProviderSubscriptionId = body.providerSubscriptionId;

  const rawSubscriptions: SubscriptionInput[] | undefined =
    body.subscriptions?.length
      ? body.subscriptions
      : body.practiceAreaIds?.map((practiceAreaId) => ({ practiceAreaId }));

  if (!rawSubscriptions?.length) {
    throw new BadRequestError(
      "subscriptions or practiceAreaIds must contain at least one item",
    );
  }

  const normalized = rawSubscriptions.map((item) => {
    if (!item.practiceAreaId?.trim()) {
      throw new BadRequestError("practiceAreaId is required");
    }

    return {
      practiceAreaId: item.practiceAreaId.trim(),
      billingCycle: assertBillingCycle(item.billingCycle || topLevelBillingCycle),
      startsAt:
        parseOptionalDate(item.startsAt || topLevelStartsAt, "startsAt") ??
        new Date(),
      expiresAt: parseOptionalDate(
        item.expiresAt ?? topLevelExpiresAt,
        "expiresAt",
      ),
      paymentProvider: item.paymentProvider || topLevelPaymentProvider,
      providerSubscriptionId:
        item.providerSubscriptionId ?? topLevelProviderSubscriptionId ?? null,
    };
  });

  const ids = uniqueIds(normalized.map((item) => item.practiceAreaId));
  if (ids.length !== normalized.length) {
    throw new BadRequestError(
      "Each practice area can only appear once per subscription request",
    );
  }

  return normalized;
};

export const getAllPracticeAreas = async (filters?: PracticeAreaFilters) => {
  const where = getPracticeAreaWhere(filters);

  const areas = await db
    .select({
      id: practiceAreas.id,
      name: practiceAreas.name,
      createdAt: practiceAreas.createdAt,
      updatedAt: practiceAreas.updatedAt,
    })
    .from(practiceAreas)
    .where(where)
    .orderBy(asc(practiceAreas.name));

  const subcategoriesByPracticeArea = await getSubcategoriesByPracticeArea(
    areas.map((area) => area.id),
  );

  return areas.map((area) => ({
    ...area,
    subcategories: subcategoriesByPracticeArea.get(area.id) ?? [],
  }));
};

export const getFirmPracticeAreas = async (
  organizationId: string,
  filters?: PracticeAreaFilters,
) => {
  const where = getPracticeAreaWhere(filters);

  const rows = await db
    .select({
      id: practiceAreas.id,
      name: practiceAreas.name,
      createdAt: practiceAreas.createdAt,
      updatedAt: practiceAreas.updatedAt,
      firmPracticeAreaId: firmPracticeAreas.id,
      firmPracticeAreaActive: firmPracticeAreas.active,
      subscriptionId: subscriptions.id,
      subscriptionStatus: subscriptions.status,
      billingCycle: subscriptions.billingCycle,
      startsAt: subscriptions.startsAt,
      expiresAt: subscriptions.expiresAt,
      cancelledAt: subscriptions.cancelledAt,
      paymentProvider: subscriptions.paymentProvider,
      providerSubscriptionId: subscriptions.providerSubscriptionId,
      subscriptionCreatedAt: subscriptions.createdAt,
    })
    .from(practiceAreas)
    .leftJoin(
      firmPracticeAreas,
      and(
        eq(firmPracticeAreas.practiceAreaId, practiceAreas.id),
        eq(firmPracticeAreas.organizationId, organizationId),
        eq(firmPracticeAreas.active, true),
      ),
    )
    .leftJoin(
      subscriptions,
      eq(subscriptions.id, firmPracticeAreas.subscriptionId),
    )
    .where(where)
    .orderBy(asc(practiceAreas.name));

  const subcategoriesByPracticeArea = await getSubcategoriesByPracticeArea(
    rows.map((row) => row.id),
  );

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    subcategories: subcategoriesByPracticeArea.get(row.id) ?? [],
    subscription: row.subscriptionId
      ? {
          id: row.subscriptionId,
          firmPracticeAreaId: row.firmPracticeAreaId,
          active: row.firmPracticeAreaActive,
          status: row.subscriptionStatus,
          billingCycle: row.billingCycle,
          startsAt: row.startsAt,
          expiresAt: row.expiresAt,
          cancelledAt: row.cancelledAt,
          paymentProvider: row.paymentProvider,
          providerSubscriptionId: row.providerSubscriptionId,
          createdAt: row.subscriptionCreatedAt,
        }
      : null,
  }));
};

export const createSubscriptions = async (
  organizationId: string,
  body: CreateSubscriptionsBody = {},
) => {
  const items = normalizeSubscriptionInputs(body);
  const requestedPracticeAreaIds = items.map((item) => item.practiceAreaId);

  const existingPracticeAreas = await db
    .select({ id: practiceAreas.id, name: practiceAreas.name })
    .from(practiceAreas)
    .where(inArray(practiceAreas.id, requestedPracticeAreaIds));

  const existingPracticeAreaIds = new Set(
    existingPracticeAreas.map((area) => area.id),
  );
  const missingPracticeAreaIds = requestedPracticeAreaIds.filter(
    (id) => !existingPracticeAreaIds.has(id),
  );

  if (missingPracticeAreaIds.length) {
    throw new NotFoundError("One or more practice areas were not found", {
      practiceAreaIds: missingPracticeAreaIds,
    });
  }

  const existingActiveFirmAreas = await db
    .select({
      practiceAreaId: firmPracticeAreas.practiceAreaId,
    })
    .from(firmPracticeAreas)
    .where(
      and(
        eq(firmPracticeAreas.organizationId, organizationId),
        eq(firmPracticeAreas.active, true),
        inArray(firmPracticeAreas.practiceAreaId, requestedPracticeAreaIds),
      ),
    );

  if (existingActiveFirmAreas.length) {
    throw new ConflictError(
      "Firm already has active subscriptions for one or more practice areas",
      {
        practiceAreaIds: existingActiveFirmAreas.map(
          (area) => area.practiceAreaId,
        ),
      },
    );
  }

  return db.transaction(async (tx) => {
    const created = [];

    for (const item of items) {
      const [subscription] = await tx
        .insert(subscriptions)
        .values({
          organizationId,
          practiceAreaId: item.practiceAreaId,
          status: SubscriptionStatus.ACTIVE,
          billingCycle: item.billingCycle,
          startsAt: item.startsAt,
          expiresAt: item.expiresAt,
          paymentProvider: item.paymentProvider,
          providerSubscriptionId: item.providerSubscriptionId,
        })
        .returning();

      const [firmPracticeArea] = await tx
        .insert(firmPracticeAreas)
        .values({
          organizationId,
          practiceAreaId: item.practiceAreaId,
          subscriptionId: subscription.id,
        })
        .returning();

      const practiceArea = existingPracticeAreas.find(
        (area) => area.id === item.practiceAreaId,
      );

      created.push({
        practiceArea,
        subscription,
        firmPracticeArea,
      });
    }

    return created;
  });
};

export const cancelSubscriptions = async (
  organizationId: string,
  body: CancelSubscriptionsBody = {},
) => {
  const subscriptionIds = uniqueIds(body.subscriptionIds ?? []);
  const practiceAreaIds = uniqueIds(body.practiceAreaIds ?? []);

  if (subscriptionIds.length && practiceAreaIds.length) {
    throw new BadRequestError(
      "Provide either subscriptionIds or practiceAreaIds, not both",
    );
  }

  if (!subscriptionIds.length && !practiceAreaIds.length) {
    throw new BadRequestError(
      "subscriptionIds or practiceAreaIds must contain at least one item",
    );
  }

  const firmAreaConditions = [
    eq(firmPracticeAreas.organizationId, organizationId),
    eq(firmPracticeAreas.active, true),
  ];

  if (subscriptionIds.length) {
    firmAreaConditions.push(
      inArray(firmPracticeAreas.subscriptionId, subscriptionIds),
    );
  }

  if (practiceAreaIds.length) {
    firmAreaConditions.push(
      inArray(firmPracticeAreas.practiceAreaId, practiceAreaIds),
    );
  }

  const activeFirmAreas = await db
    .select({
      subscriptionId: firmPracticeAreas.subscriptionId,
      practiceAreaId: firmPracticeAreas.practiceAreaId,
    })
    .from(firmPracticeAreas)
    .where(and(...firmAreaConditions));

  if (!activeFirmAreas.length) {
    throw new NotFoundError("No active subscriptions found");
  }

  const matchedSubscriptionIds = activeFirmAreas.map(
    (area) => area.subscriptionId,
  );
  const now = new Date();

  return db.transaction(async (tx) => {
    const cancelledSubscriptions = await tx
      .update(subscriptions)
      .set({
        status: SubscriptionStatus.CANCELLED,
        cancelledAt: now,
      })
      .where(
        and(
          eq(subscriptions.organizationId, organizationId),
          inArray(subscriptions.id, matchedSubscriptionIds),
        ),
      )
      .returning();

    await tx
      .update(firmPracticeAreas)
      .set({ active: false })
      .where(
        and(
          eq(firmPracticeAreas.organizationId, organizationId),
          inArray(firmPracticeAreas.subscriptionId, matchedSubscriptionIds),
        ),
      );

    return cancelledSubscriptions;
  });
};

type PracticeAreaTreeNode = {
  id: string;
  name: string;
  children: PracticeAreaTreeNode[];
};

type PracticeAreaTreeData = {
  practiceAreaTreeNodes: PracticeAreaTreeNode[];
  practiceAreaIds: string[];
  subcategoryIds: string[];
  caseTypeIds: string[];
  practiceAreaNameLookup: Record<string, string>;
};

export const getTreeData = async (): Promise<PracticeAreaTreeData> => {
  const areas = await db
    .select({
      id: practiceAreas.id,
      name: practiceAreas.name,
    })
    .from(practiceAreas)
    .orderBy(asc(practiceAreas.name));

  const subcategoriesByPracticeArea = await getSubcategoriesByPracticeArea(
    areas.map((a) => a.id),
  );

  const practiceAreaIds: string[] = [];
  const subcategoryIds: string[] = [];
  const caseTypeIds: string[] = [];
  const practiceAreaNameLookup: Record<string, string> = {};
  const practiceAreaTreeNodes: PracticeAreaTreeNode[] = [];

  for (const area of areas) {
    practiceAreaIds.push(area.id);
    practiceAreaNameLookup[area.id] = area.name;

    const subcategories = subcategoriesByPracticeArea.get(area.id) ?? [];
    const children: PracticeAreaTreeNode[] = [];

    for (const sub of subcategories as {
      id: string;
      name: string;
      caseTypes: { id: string; name: string }[];
    }[]) {
      subcategoryIds.push(sub.id);
      practiceAreaNameLookup[sub.id] = sub.name;

      const grandchildren: PracticeAreaTreeNode[] = [];
      for (const ct of sub.caseTypes ?? []) {
        caseTypeIds.push(ct.id);
        practiceAreaNameLookup[ct.id] = ct.name;
        grandchildren.push({ id: ct.id, name: ct.name, children: [] });
      }

      children.push({ id: sub.id, name: sub.name, children: grandchildren });
    }

    practiceAreaTreeNodes.push({
      id: area.id,
      name: area.name,
      children,
    });
  }

  return {
    practiceAreaTreeNodes,
    practiceAreaIds,
    subcategoryIds,
    caseTypeIds,
    practiceAreaNameLookup,
  };
};

export class PracticeAreasService {
  getAllPracticeAreas = getAllPracticeAreas;
  getFirmPracticeAreas = getFirmPracticeAreas;
  createSubscriptions = createSubscriptions;
  cancelSubscriptions = cancelSubscriptions;
  getTreeData = getTreeData;
}
