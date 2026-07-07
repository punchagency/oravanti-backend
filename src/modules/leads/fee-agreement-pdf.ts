import PDFDocument from "pdfkit";
import type { FeeAgreementDocument } from "./fee-agreement-document";

// ─── Formatting helpers (ported from the frontend fee-agreement-document.ts so
// the generated PDF and the in-app preview render the same content) ──────────

const money = (n: number): string =>
  `$${n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const formatDate = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
};

const paymentTermsText = (
  plan: FeeAgreementDocument["paymentPlan"],
  firmName: string,
): string => {
  const pay = `Payment may be made by ACH bank transfer, credit card (3% processing fee applies), or certified check payable to ${firmName}.`;
  if (plan === "two_payments")
    return `The total amount is payable in two equal installments: the first due upon signing this agreement and the second within 30 days. ${pay}`;
  if (plan === "installments")
    return `The total amount is payable in monthly installments per a schedule agreed with the firm, beginning upon signing this agreement. ${pay}`;
  return `The total amount is due in full upon signing this agreement. ${pay} Failure to remit payment within 7 days of signing may result in withdrawal of representation.`;
};

// Muted uppercase section label. Pass `x`/`width` to pin it to a specific
// column (pdfkit otherwise resets x to the left margin after each .text(), which
// would overlap right-column labels onto the left ones).
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

/**
 * Renders the fee-agreement document to a PDF buffer using pdfkit (same in-repo
 * pattern as questionnaires.service.ts). The prose mirrors the frontend preview
 * in oravanti/src/pages/admin/intake/components/fee-agreement-document.ts.
 *
 * A Dropbox Sign text-tag anchor is embedded in the client signature block. When
 * the signature request is created with `useTextTags: true, hideTextTags: true`
 * the anchor is replaced by the signature/date fields and hidden from the final
 * document. `signerId` matches the signer index sent to Dropbox Sign (default
 * "signer1" — the client).
 */
export const renderFeeAgreementPdf = async (
  document: FeeAgreementDocument,
  opts: { signerId?: string } = {},
): Promise<Buffer> => {
  const signerId = opts.signerId ?? "signer1";
  const firmName = document.firm.name;
  const state = document.firm.state ?? "the applicable";
  const cityCounty = document.firm.city
    ? `${document.firm.city} County`
    : "the firm's county";

  const cityStateZip = [
    document.firm.city,
    [document.firm.state, document.firm.zipCode].filter(Boolean).join(" "),
  ]
    .filter(Boolean)
    .join(", ");
  const firmAddressLine = [document.firm.address, cityStateZip]
    .filter(Boolean)
    .join(" · ");
  const firmContactLine = [
    document.firm.phone ? `T: ${document.firm.phone}` : null,
    document.firm.email,
  ]
    .filter(Boolean)
    .join(" · ");

  const doc = new PDFDocument({ margin: 56, size: "A4" });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });

  const contentWidth =
    doc.page.width - doc.page.margins.left - doc.page.margins.right;

  // ── Firm header ────────────────────────────────────────────────────────────
  doc
    .font("Helvetica-Bold")
    .fontSize(16)
    .fillColor("#1a1a1a")
    .text(firmName, { align: "center" });
  doc.font("Helvetica").fontSize(9).fillColor("#666");
  if (firmAddressLine) doc.text(firmAddressLine, { align: "center" });
  if (firmContactLine) doc.text(firmContactLine, { align: "center" });
  doc.moveDown(0.6);
  hr(doc);

  doc
    .font("Helvetica-Bold")
    .fontSize(14)
    .fillColor("#1a1a1a")
    .text("Legal Services Agreement", { align: "center" });
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor("#8a8577")
    .text("Retainer & fee agreement", { align: "center" });
  doc.moveDown(1);

  // ── Document ref / date prepared ──────────────────────────────────────────
  const metaTop = doc.y;
  drawLabel(doc, "Document ref");
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#1a1a1a").text(document.docRef);
  const metaBottom = doc.y;
  doc.y = metaTop;
  drawLabel(doc, "Date prepared", { align: "right" });
  doc
    .font("Helvetica-Bold")
    .fontSize(11)
    .fillColor("#1a1a1a")
    .text(formatDate(document.datePrepared), { align: "right" });
  doc.y = Math.max(metaBottom, doc.y);
  doc.moveDown(1);

  // ── Parties (firm | client) ───────────────────────────────────────────────
  const colGap = 24;
  const colWidth = (contentWidth - colGap) / 2;
  const leftX = doc.page.margins.left;
  const rightX = leftX + colWidth + colGap;
  const partiesTop = doc.y;

  drawLabel(doc, "Law firm (service provider)", { x: leftX, width: colWidth });
  doc.moveDown(0.3);
  doc.font("Helvetica-Bold").fontSize(11).text(firmName, leftX, doc.y, { width: colWidth });
  doc.font("Helvetica").fontSize(9).fillColor("#555");
  if (document.firm.address)
    doc.text(document.firm.address, leftX, doc.y, { width: colWidth });
  if (cityStateZip) doc.text(cityStateZip, leftX, doc.y, { width: colWidth });
  doc.moveDown(0.3);
  doc.text(`Attorney: ${document.attorneyName}`, leftX, doc.y, { width: colWidth });
  const leftBottom = doc.y;

  doc.y = partiesTop;
  drawLabel(doc, "Client (service recipient)", { x: rightX, width: colWidth });
  doc.moveDown(0.3);
  doc
    .font("Helvetica-Bold")
    .fontSize(11)
    .fillColor("#1a1a1a")
    .text(document.client.name, rightX, doc.y, { width: colWidth });
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor("#555")
    .text(`Matter type: ${document.client.matterType}`, rightX, doc.y, {
      width: colWidth,
    });
  doc.y = Math.max(leftBottom, doc.y);
  doc.x = leftX;
  doc.fillColor("#1a1a1a");
  doc.moveDown(1.2);

  // ── Scope of representation ───────────────────────────────────────────────
  drawLabel(doc, "Scope of representation");
  doc.moveDown(0.3);
  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor("#333")
    .text(
      `${firmName} agrees to provide legal representation in the matter identified above. ` +
        "Services include preparation and filing of all applicable forms, correspondence with " +
        "relevant government agencies, and legal advice throughout the proceedings. This agreement " +
        "does not cover appeals, removal proceedings, or matters outside the stated matter type " +
        "unless a separate written agreement is executed.",
      { width: contentWidth, align: "left" },
    );
  doc.moveDown(1);

  // ── Attorney fees table ───────────────────────────────────────────────────
  drawLabel(doc, "Attorney fees");
  doc.moveDown(0.4);
  const amountColWidth = 110;
  const descColWidth = contentWidth - amountColWidth;
  const rowText = (desc: string, amount: string, bold: boolean) => {
    const font = bold ? "Helvetica-Bold" : "Helvetica";
    const rowTop = doc.y;
    doc.font(font).fontSize(10).fillColor("#1a1a1a").text(desc, leftX, rowTop, {
      width: descColWidth,
    });
    const rowAfterDesc = doc.y;
    doc.font(font).fontSize(10).text(amount, leftX + descColWidth, rowTop, {
      width: amountColWidth,
      align: "right",
    });
    doc.y = Math.max(rowAfterDesc, doc.y);
    doc.moveDown(0.3);
  };
  // header
  doc
    .font("Helvetica-Bold")
    .fontSize(8)
    .fillColor("#8a8577")
    .text("DESCRIPTION", leftX, doc.y, { width: descColWidth, continued: true })
    .text("AMOUNT", { width: amountColWidth, align: "right" });
  doc.moveDown(0.3);
  doc.fillColor("#1a1a1a");
  for (const line of document.feeLines) rowText(line.description, money(line.amount), false);
  hr(doc);
  rowText("Total due", money(document.totalDue), true);
  doc.moveDown(0.8);

  // ── Account allocation ────────────────────────────────────────────────────
  // Pin to the left margin: the preceding fee-table amount column leaves doc.x
  // shifted right, which would otherwise offset this section label.
  drawLabel(doc, "Account allocation", { x: leftX, width: contentWidth });
  doc.moveDown(0.4);
  const allocTop = doc.y;
  const allocCol = contentWidth / 3;
  const allocCell = (idx: number, title: string, value: string) => {
    const x = leftX + idx * allocCol;
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor("#8a8577")
      .text(title.toUpperCase(), x, allocTop, { width: allocCol });
    doc
      .font("Helvetica-Bold")
      .fontSize(12)
      .fillColor("#1a1a1a")
      .text(value, x, allocTop + 12, { width: allocCol });
  };
  allocCell(0, "Operating account", money(document.allocation.operating));
  allocCell(1, "Trust (IOLTA)", money(document.allocation.trust));
  allocCell(2, "Total", money(document.allocation.total));
  doc.y = allocTop + 34;
  doc.x = leftX;
  doc.moveDown(0.8);

  // ── Payment terms ─────────────────────────────────────────────────────────
  drawLabel(doc, "Payment terms");
  doc.moveDown(0.3);
  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor("#333")
    .text(paymentTermsText(document.paymentPlan, firmName), leftX, doc.y, {
      width: contentWidth,
    });
  doc.moveDown(0.8);

  if (document.applyConsultationCredit) {
    drawLabel(doc, "Consultation fee credit");
    doc.moveDown(0.3);
    const amt =
      document.consultationFeeAmount != null
        ? ` of ${money(document.consultationFeeAmount)}`
        : "";
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor("#555")
      .text(
        `If a consultation fee${amt} was collected prior to this engagement, it will be credited ` +
          "against the total amount due at the discretion of the supervising attorney. Please " +
          "reference your consultation receipt when making payment.",
        leftX,
        doc.y,
        { width: contentWidth },
      );
    doc.moveDown(0.8);
  }

  // ── Terms & conditions ────────────────────────────────────────────────────
  drawLabel(doc, "Terms & conditions");
  doc.moveDown(0.3);
  const terms = [
    "This agreement constitutes the entire understanding between the parties regarding legal representation in the matter stated above.",
    "Either party may terminate this agreement upon written notice. Client remains responsible for fees incurred prior to termination.",
    `${firmName} maintains professional liability insurance as required by ${state} State bar rules.`,
    `Disputes arising from this agreement shall be resolved by binding arbitration under the AAA Commercial Rules in ${cityCounty}.`,
    `This agreement is governed by the laws of the State of ${state}.`,
  ];
  doc.font("Helvetica").fontSize(9).fillColor("#666");
  terms.forEach((t, i) => {
    doc.text(`${i + 1}. ${t}`, leftX, doc.y, { width: contentWidth });
    doc.moveDown(0.2);
  });
  doc.moveDown(1.5);

  // ── Signature blocks ──────────────────────────────────────────────────────
  const sigTop = doc.y;
  drawLabel(doc, "Client signature", { x: leftX, width: colWidth });
  doc.moveDown(2);
  // Dropbox Sign text-tag anchor (hidden via hideTextTags when the request is
  // created). Rendered light so it stays unobtrusive if tags are not stripped.
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor("#ffffff")
    .text(`[sig|req|${signerId}]`, leftX, doc.y, { width: colWidth });
  doc
    .fontSize(10)
    .fillColor("#1a1a1a")
    .text(document.client.name, leftX, doc.y, { width: colWidth });
  doc
    .fontSize(9)
    .fillColor("#888")
    .text("Date: [date|req|" + signerId + "]", leftX, doc.y, { width: colWidth })
    .fillColor("#888");
  const clientBottom = doc.y;

  doc.y = sigTop;
  drawLabel(doc, "Attorney signature", { x: rightX, width: colWidth });
  // Attorney counter-signature is out of scope for now (client-only); rendered
  // as a manual line so the printed document still has an attorney block.
  doc.moveDown(3.5);
  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor("#1a1a1a")
    .text(`${document.attorneyName}, Esq.`, rightX, doc.y, { width: colWidth });
  doc
    .fontSize(9)
    .fillColor("#888")
    .text("Date: __________________", rightX, doc.y, { width: colWidth });
  doc.y = Math.max(clientBottom, doc.y);
  doc.x = leftX;

  doc.end();
  return done;
};
