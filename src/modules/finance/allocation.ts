import { toMoney, trustFirstSplit } from "./money";

/**
 * Applying a payment in the order the fee agreement promised the client.
 *
 * A fee agreement can state how payments are applied between attorney fees and
 * costs, and that sentence is printed into the document the client signs. This
 * is where the promise is kept.
 *
 * ## Four buckets, two numbers
 *
 * The promise is on the fee/cost axis; the ledger stores operating/trust. These
 * are different axes and neither derives from the other — a government filing
 * fee is a *cost* held in *trust*, while other disbursements are *costs* landing
 * in *operating* beside the firm's own fee. Crossing them gives four buckets:
 *
 *              operating            trust
 *     fee      attorney fees        (never, today)
 *     cost     disbursements        filing fees
 *
 * Every line belongs to exactly one bucket, so filling buckets in the agreed
 * order and reading off the two account columns yields the `(operating, trust)`
 * pair `invoice_payments` already stores. Nothing is estimated at read time, so
 * "IOLTA funds must be tracked, not estimated" and the
 * `invoice_payments_split_balances` CHECK both still hold.
 *
 * Buckets are **net**, which is what makes a credit line safe: the
 * "Less consultation fee already paid" line is a negative fee, and netting it
 * into its bucket reduces what fees are owed rather than trying to pay a
 * negative amount.
 *
 * ## Cumulative placement, then a delta
 *
 * Payments carry no line reference — the only stored figure is
 * `invoices.amount_paid`. So this never asks "where does *this* payment go". It
 * asks where the invoice's whole paid-to-date lands, before and after, and
 * returns the difference:
 *
 *     split = place(alreadyPaid + amount) − place(alreadyPaid)
 *
 * That is what lets a second payment resume exactly where the first stopped,
 * for every order including the percentage split, with no replay logic that
 * could disagree with the placement it replays. `place` is a pure function of
 * the paid total, so the same total always gives the same answer.
 */

export type PaymentApplicationOrder = "fees_first" | "costs_first" | "custom";

export type AllocatableLine = {
  amount: number;
  account: "operating" | "trust_iolta";
  /** Null on any line whose source drew no fee/cost distinction. */
  category: "fee" | "cost" | null;
};

export type AccountSplit = { operating: number; trust: number };

type Bucket = { account: "operating" | "trust_iolta"; amount: number };

/**
 * The net amount owed in each account for one category, client money first.
 *
 * Trust before operating because the agreement's clause orders fees against
 * costs and says nothing about the sequence *inside* either — which leaves a
 * free choice, and only one option is defensible. Both a filing fee and a
 * courier charge are "costs and disbursements", so on a `costs_first` agreement
 * plain line order could pay operating disbursements before the client's money
 * held in trust. Funding trust first inside a category costs nothing against
 * the promise, because the promise does not reach here.
 */
const bucketsFor = (
  lines: AllocatableLine[],
  category: "fee" | "cost",
): Bucket[] => {
  const net = { trust_iolta: 0, operating: 0 };
  for (const line of lines) {
    if (line.category !== category) continue;
    net[line.account] = toMoney(net[line.account] + line.amount);
  }
  return (["trust_iolta", "operating"] as const)
    .map((account) => ({ account, amount: net[account] }))
    .filter((b) => b.amount > 0);
};

const totalOf = (buckets: Bucket[]) =>
  toMoney(buckets.reduce((sum, b) => sum + b.amount, 0));

/** Fill `available` down the buckets in order, summing by account. */
const fill = (buckets: Bucket[], available: number): AccountSplit => {
  let remaining = toMoney(available);
  const split = { operating: 0, trust: 0 };

  for (const bucket of buckets) {
    if (remaining <= 0) break;
    const applied = Math.min(remaining, bucket.amount);
    remaining = toMoney(remaining - applied);
    if (bucket.account === "trust_iolta") {
      split.trust = toMoney(split.trust + applied);
    } else {
      split.operating = toMoney(split.operating + applied);
    }
  }
  return split;
};

/**
 * Divide a paid total between the two categories under the percentage rule.
 *
 * The clause reads "allocated N% to attorney fees and (100−N)% to costs", so
 * this is a ratio rather than an order. Each side is capped by what it owes,
 * and whatever one side cannot absorb goes to the other — otherwise a
 * fully-paid fee side would strand money the client plainly owes on costs.
 */
const percentageShares = (
  paid: number,
  feeTotal: number,
  costTotal: number,
  feePercent: number,
): { fees: number; costs: number } => {
  const pct = Math.min(Math.max(feePercent, 0), 100);
  let fees = Math.min(toMoney((paid * pct) / 100), feeTotal);
  let costs = Math.min(toMoney(paid - fees), costTotal);

  const spare = toMoney(paid - fees - costs);
  if (spare > 0) {
    fees = Math.min(toMoney(fees + spare), feeTotal);
    costs = Math.min(toMoney(paid - fees), costTotal);
  }
  return { fees, costs };
};

/** Where the invoice's entire paid-to-date lands, by account. */
const place = (
  paid: number,
  lines: AllocatableLine[],
  order: PaymentApplicationOrder,
  feePercent: number | null,
): AccountSplit => {
  const fees = bucketsFor(lines, "fee");
  const costs = bucketsFor(lines, "cost");

  const ordered =
    order === "fees_first"
      ? [...fees, ...costs]
      : order === "costs_first"
        ? [...costs, ...fees]
        : null;

  if (ordered) {
    const split = fill(ordered, paid);
    return withOverpayment(split, paid, totalOf(ordered));
  }

  const feeTotal = totalOf(fees);
  const costTotal = totalOf(costs);
  const shares = percentageShares(paid, feeTotal, costTotal, feePercent ?? 0);
  const a = fill(fees, shares.fees);
  const b = fill(costs, shares.costs);
  const split = {
    operating: toMoney(a.operating + b.operating),
    trust: toMoney(a.trust + b.trust),
  };
  return withOverpayment(split, paid, toMoney(feeTotal + costTotal));
};

/**
 * More paid than the invoice's lines account for — an overpayment. It is the
 * firm's revenue rather than client money, the same call `trustFirstSplit`
 * makes when nothing is owed to trust.
 */
const withOverpayment = (
  split: AccountSplit,
  paid: number,
  owed: number,
): AccountSplit =>
  paid > owed
    ? { ...split, operating: toMoney(split.operating + (paid - owed)) }
    : split;

/**
 * How a payment against this invoice divides between operating and trust.
 *
 * Falls back to `trustFirstSplit` — today's behaviour, unchanged — when the
 * invoice carries no application order, or when any line is unclassified. That
 * second condition matters: a partly-classified invoice cannot be placed
 * honestly, and inferring which side an untagged line belongs to is exactly the
 * guesswork the category column exists to avoid.
 */
export const applicationSplit = (
  amount: number,
  lines: AllocatableLine[],
  alreadyPaid: number,
  order: PaymentApplicationOrder | null,
  feePercent: number | null,
  operatingOutstanding: number,
  trustOutstanding: number,
): AccountSplit => {
  const classified = lines.length > 0 && lines.every((l) => l.category !== null);
  if (order == null || !classified) {
    return trustFirstSplit(amount, operatingOutstanding, trustOutstanding);
  }

  const before = place(toMoney(alreadyPaid), lines, order, feePercent);
  const after = place(toMoney(alreadyPaid + amount), lines, order, feePercent);

  return {
    operating: toMoney(after.operating - before.operating),
    trust: toMoney(after.trust - before.trust),
  };
};
