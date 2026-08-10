import PDFDocument from "pdfkit";

/**
 * Renders an invoice to a PDF buffer, following the same pdfkit conventions as
 * `src/modules/leads/fee-agreement-pdf.ts`.
 *
 * This is the ONLY invoice renderer. The frontend's Download PDF hits
 * `GET /finance/invoices/:id/pdf` rather than printing its own HTML, so the
 * document a client is emailed, the copy archived in R2, and anything a
 * fee-earner downloads are byte-identical. Two renderers would drift, and an
 * archived copy that disagrees with the live view is worse than no archive.
 *
 * Trust lines are filtered by the caller (`getById` already withholds them from
 * anyone without IOLTA access), so nothing here needs to re-check.
 */

export type InvoicePdfInput = {
  invoiceNumber: string;
  status: string;
  issueDate: string;
  dueDate: string;
  notes: string | null;
  filingType: string | null;
  client: { name: string; email: string | null };
  matter: { reference: string | null } | null;
  attorney: string | null;
  lineItems: {
    description: string;
    quantity: number;
    rate: number;
    amount: number;
    account: "operating" | "trust_iolta";
  }[];
  totals: {
    operating: number;
    trust: number | null;
    total: number;
    amountPaid: number;
    balanceDue: number;
  };
  /**
   * The payment schedule, already allocated. Empty when the invoice is due in
   * one payment.
   *
   * Allocation state is passed in rather than recomputed here, so the document
   * the client receives cannot describe the schedule differently from the
   * screen the firm is looking at.
   */
  instalments: {
    sequence: number;
    dueDate: string;
    amount: number;
    amountPaid: number;
    outstanding: number;
    state: "paid" | "partial" | "due" | "overdue";
  }[];
  firm: {
    name: string;
    email: string | null;
    phone: string | null;
    address: string | null;
  };
};

const money = (n: number): string =>
  `$${n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * "2026-08-06" → "August 6, 2026". Pure string math — never construct a Date
 * here, so the rendered day cannot shift with the server timezone. Same
 * reasoning as `formatDateOnly` in fee-agreement-pdf.ts.
 */
const formatDateOnly = (ymd: string): string => {
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d || !MONTH_NAMES[m - 1]) return "—";
  return `${MONTH_NAMES[m - 1]} ${d}, ${y}`;
};

const drawLabel = (
  doc: PDFKit.PDFDocument,
  text: string,
  opts: { x?: number; width?: number; align?: "left" | "right" } = {},
) => {
  doc.fontSize(8).fillColor("#8a8577").font("Helvetica-Bold");
  if (opts.x !== undefined) {
    doc.text(text.toUpperCase(), opts.x, doc.y, {
      width: opts.width,
      align: opts.align ?? "left",
      characterSpacing: 0.5,
    });
  } else {
    doc.text(text.toUpperCase(), {
      align: opts.align ?? "left",
      characterSpacing: 0.5,
    });
  }
  doc.font("Helvetica").fillColor("#1a1a1a");
};

const hr = (doc: PDFKit.PDFDocument) => {
  const y = doc.y + 6;
  doc
    .moveTo(doc.page.margins.left, y)
    .lineTo(doc.page.width - doc.page.margins.right, y)
    .lineWidth(0.5)
    .strokeColor("#e6e3da")
    .stroke();
  doc.moveDown(1);
};

export const renderInvoicePdf = async (
  invoice: InvoicePdfInput,
): Promise<Buffer> => {
  const doc = new PDFDocument({ margin: 56, size: "A4" });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });

  const left = doc.page.margins.left;
  const contentWidth =
    doc.page.width - doc.page.margins.left - doc.page.margins.right;

  const firmContactLine = [
    invoice.firm.phone ? `T: ${invoice.firm.phone}` : null,
    invoice.firm.email,
  ]
    .filter(Boolean)
    .join(" · ");

  // ── Firm header ───────────────────────────────────────────────────────────
  doc
    .font("Helvetica-Bold")
    .fontSize(16)
    .fillColor("#1a1a1a")
    .text(invoice.firm.name, { align: "center" });
  doc.font("Helvetica").fontSize(9).fillColor("#666");
  if (invoice.firm.address) doc.text(invoice.firm.address, { align: "center" });
  if (firmContactLine) doc.text(firmContactLine, { align: "center" });
  doc.moveDown(0.6);
  hr(doc);

  doc
    .font("Helvetica-Bold")
    .fontSize(14)
    .fillColor("#1a1a1a")
    .text("Invoice", { align: "center" });
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor("#8a8577")
    .text(invoice.invoiceNumber, { align: "center" });
  doc.moveDown(1);

  // ── Bill-to / dates ───────────────────────────────────────────────────────
  const metaTop = doc.y;
  const colWidth = contentWidth / 2 - 10;

  drawLabel(doc, "Billed to");
  doc.font("Helvetica-Bold").fontSize(11).text(invoice.client.name, {
    width: colWidth,
  });
  doc.font("Helvetica").fontSize(9).fillColor("#666");
  if (invoice.client.email) doc.text(invoice.client.email, { width: colWidth });
  if (invoice.matter?.reference) {
    doc.text(`Matter: ${invoice.matter.reference}`, { width: colWidth });
  }
  if (invoice.filingType) {
    doc.text(`Filing type: ${invoice.filingType}`, { width: colWidth });
  }
  if (invoice.attorney) {
    doc.text(`Attorney: ${invoice.attorney}`, { width: colWidth });
  }
  const leftBottom = doc.y;

  doc.y = metaTop;
  const rightX = left + contentWidth / 2 + 10;
  drawLabel(doc, "Issue date", { x: rightX, width: colWidth, align: "right" });
  doc
    .font("Helvetica-Bold")
    .fontSize(11)
    .fillColor("#1a1a1a")
    .text(formatDateOnly(invoice.issueDate), rightX, doc.y, {
      width: colWidth,
      align: "right",
    });
  doc.moveDown(0.4);
  drawLabel(doc, "Due date", { x: rightX, width: colWidth, align: "right" });
  doc
    .font("Helvetica-Bold")
    .fontSize(11)
    .fillColor("#1a1a1a")
    .text(formatDateOnly(invoice.dueDate), rightX, doc.y, {
      width: colWidth,
      align: "right",
    });

  doc.y = Math.max(leftBottom, doc.y) + 10;
  doc.x = left;
  hr(doc);

  // ── Line items ────────────────────────────────────────────────────────────
  const cols = {
    description: left,
    qty: left + contentWidth * 0.56,
    rate: left + contentWidth * 0.68,
    amount: left + contentWidth * 0.84,
  };
  const widths = {
    description: contentWidth * 0.54,
    qty: contentWidth * 0.1,
    rate: contentWidth * 0.14,
    amount: contentWidth * 0.16,
  };

  const headerY = doc.y;
  doc.fontSize(8).fillColor("#8a8577").font("Helvetica-Bold");
  doc.text("DESCRIPTION", cols.description, headerY, { width: widths.description });
  doc.text("QTY", cols.qty, headerY, { width: widths.qty, align: "right" });
  doc.text("RATE", cols.rate, headerY, { width: widths.rate, align: "right" });
  doc.text("AMOUNT", cols.amount, headerY, { width: widths.amount, align: "right" });
  doc.y = headerY;
  doc.moveDown(1.2);
  doc.font("Helvetica").fillColor("#1a1a1a");

  for (const line of invoice.lineItems) {
    // Page-break guard: pdfkit will not do this for a manually positioned row.
    if (doc.y > doc.page.height - doc.page.margins.bottom - 120) {
      doc.addPage();
    }
    const rowY = doc.y;
    const label =
      line.account === "trust_iolta"
        ? `${line.description}  (held in trust)`
        : line.description;

    doc.fontSize(10);
    doc.text(label, cols.description, rowY, { width: widths.description });
    const rowBottom = doc.y;
    doc.text(String(line.quantity), cols.qty, rowY, {
      width: widths.qty,
      align: "right",
    });
    doc.text(money(line.rate), cols.rate, rowY, {
      width: widths.rate,
      align: "right",
    });
    doc.font("Helvetica-Bold").text(money(line.amount), cols.amount, rowY, {
      width: widths.amount,
      align: "right",
    });
    doc.font("Helvetica");
    doc.y = rowBottom;
    doc.moveDown(0.5);
  }

  doc.x = left;
  hr(doc);

  // ── Totals ────────────────────────────────────────────────────────────────
  const totalsX = left + contentWidth * 0.55;
  const totalsWidth = contentWidth * 0.45;
  const labelWidth = totalsWidth * 0.55;
  const valueWidth = totalsWidth * 0.45;

  const totalRow = (
    label: string,
    value: string,
    opts: { bold?: boolean; spaceBefore?: number } = {},
  ) => {
    const { bold = false, spaceBefore = 0 } = opts;
    if (spaceBefore) doc.moveDown(spaceBefore);
    const y = doc.y;
    doc
      .font(bold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(10)
      .fillColor(bold ? "#1a1a1a" : "#666")
      .text(label, totalsX, y, { width: labelWidth });
    const labelBottom = doc.y;
    doc
      .font("Helvetica-Bold")
      .fillColor("#1a1a1a")
      .text(value, totalsX + labelWidth, y, {
        width: valueWidth,
        align: "right",
      });
    // Continue from the BOTTOM of the taller of the two columns. Resetting to
    // `y` — the top of the row — and advancing by a fraction of a line was
    // moving less than the text's own height, so each row printed over the one
    // before it.
    doc.y = Math.max(labelBottom, doc.y);
    doc.moveDown(0.35);
  };

  if (invoice.totals.trust !== null && invoice.totals.trust > 0) {
    totalRow("Attorney fees & services", money(invoice.totals.operating));
    totalRow("Filing fees (held in trust)", money(invoice.totals.trust));
  }
  totalRow("Total", money(invoice.totals.total), { bold: true });
  if (invoice.totals.amountPaid > 0) {
    totalRow("Amount paid", money(invoice.totals.amountPaid));
  }
  // Set apart from the arithmetic above it: the balance is the one figure the
  // client is being asked to act on, and it read as just another row.
  totalRow("Balance due", money(invoice.totals.balanceDue), {
    bold: true,
    spaceBefore: 0.8,
  });

  doc.x = left;
  doc.moveDown(1);

  // ── Payment schedule ──────────────────────────────────────────────────────
  // Only when there is one. An invoice due in a single payment already says so
  // in the "Balance due" row above, and an empty schedule table would read like
  // something had failed to load.
  if (invoice.instalments.length > 0) {
    doc.x = left;
    drawLabel(doc, "Payment schedule");
    doc.moveDown(0.2);

    const seqX = left;
    const dateX = left + contentWidth * 0.1;
    const amountX = left + contentWidth * 0.45;
    const stateX = left + contentWidth * 0.68;
    const amountW = contentWidth * 0.2;
    const stateW = contentWidth * 0.32;

    const STATE_LABEL: Record<string, string> = {
      paid: "Paid",
      partial: "Part paid",
      overdue: "Overdue",
      due: "Due",
    };

    for (const row of invoice.instalments) {
      if (doc.y > doc.page.height - doc.page.margins.bottom - 80) {
        doc.addPage();
      }
      const y = doc.y;
      const settled = row.state === "paid";

      // A part-paid instalment says so whatever else is true of it. Showing
      // only "Overdue" on one that is half settled would ask the client for
      // money they have already sent.
      const partPaid = row.amountPaid > 0 && row.outstanding > 0;
      const label = partPaid
        ? `${STATE_LABEL[row.state] ?? ""} — ${money(row.outstanding)} outstanding`
        : (STATE_LABEL[row.state] ?? "");

      doc
        .font("Helvetica")
        .fontSize(9)
        .fillColor("#8a8577")
        .text(`${row.sequence}.`, seqX, y, { width: contentWidth * 0.08 });
      let bottom = doc.y;

      doc
        .font("Helvetica")
        .fontSize(9)
        .fillColor(settled ? "#8a8577" : "#1a1a1a")
        .text(formatDateOnly(row.dueDate), dateX, y, {
          width: contentWidth * 0.34,
        });
      bottom = Math.max(bottom, doc.y);

      doc
        .font(settled ? "Helvetica" : "Helvetica-Bold")
        .fillColor(settled ? "#8a8577" : "#1a1a1a")
        .text(money(row.amount), amountX, y, {
          width: amountW,
          align: "right",
        });
      bottom = Math.max(bottom, doc.y);

      doc
        .font("Helvetica")
        .fontSize(9)
        // Overdue is the only thing on this page the client has to act on
        // differently, so it is the only thing coloured.
        .fillColor(row.state === "overdue" ? "#b03030" : "#8a8577")
        .text(label, stateX, y, { width: stateW, align: "right" });
      bottom = Math.max(bottom, doc.y);

      // Continue below the tallest column. Resetting to `y` and advancing by a
      // fraction of a line moves less than the text's own height, which is what
      // had the totals block printing over itself.
      doc.y = bottom;
      doc.moveDown(0.3);
    }

    doc.x = left;
    doc.moveDown(0.8);
  }

  // ── Notes ─────────────────────────────────────────────────────────────────
  if (invoice.notes) {
    doc.x = left;
    drawLabel(doc, "Notes");
    doc.font("Helvetica").fontSize(9).fillColor("#444").text(invoice.notes, {
      width: contentWidth,
    });
    doc.moveDown(1);
  }

  if (invoice.totals.trust !== null && invoice.totals.trust > 0) {
    doc.x = left;
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor("#8a8577")
      .text(
        "Filing fees are held in a client trust account (IOLTA) and are disbursed to the relevant agency on your behalf. They are not firm income.",
        { width: contentWidth },
      );
  }

  doc.end();
  return done;
};
