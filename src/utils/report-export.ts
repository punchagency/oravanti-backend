/**
 * Render a tabular report as CSV or PDF from one shared column spec, so the two
 * formats can never drift in which columns they show or how a cell is
 * formatted.
 *
 * CSV uses `fast-csv` (chosen over a write-only lib so the same dependency can
 * parse uploads later); PDF uses `pdfkit`, already used for fee agreements.
 */
import { writeToString } from "fast-csv";
import PDFDocument from "pdfkit";

export type ExportFormat = "csv" | "pdf";

export type ReportColumn<T> = {
  header: string;
  value: (row: T) => unknown;
  /** Relative width hint for PDF layout; defaults to 1. */
  weight?: number;
};

/** One place that decides how a raw value becomes a cell string. */
const formatCell = (value: unknown): string => {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value);
};

// ── CSV ──────────────────────────────────────────────────────────────────────

export const renderCsv = async <T>(
  rows: T[],
  columns: ReportColumn<T>[],
): Promise<string> => {
  const header = columns.map((c) => c.header);
  const data = rows.map((r) => columns.map((c) => formatCell(c.value(r))));
  const csv = await writeToString([header, ...data]);
  // Leading BOM so Excel opens UTF-8 (accents, non-Latin names) correctly.
  // Written as an escape rather than a literal U+FEFF: the character is
  // invisible in a diff, so a literal one cannot be told apart from an
  // accidental paste — and deleting it silently breaks Excel.
  return `\uFEFF${csv}`;
};

// ── PDF ──────────────────────────────────────────────────────────────────────

const PAGE_MARGIN = 40;
const HEADER_FILL = "#f3f4f6";
const BORDER = "#e5e7eb";
const ROW_PADDING = 6;

export const renderPdf = async <T>(
  rows: T[],
  columns: ReportColumn<T>[],
  opts: { title: string; subtitle?: string },
): Promise<Buffer> => {
  // Landscape: report tables are wide.
  const doc = new PDFDocument({ margin: PAGE_MARGIN, size: "A4", layout: "landscape" });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const contentWidth = right - left;

  doc.font("Helvetica-Bold").fontSize(16).fillColor("#111827").text(opts.title);
  if (opts.subtitle) {
    doc.moveDown(0.2);
    doc.font("Helvetica").fontSize(9).fillColor("#6b7280").text(opts.subtitle);
  }
  doc.moveDown(0.6);

  const totalWeight = columns.reduce((sum, c) => sum + (c.weight ?? 1), 0);
  const widths = columns.map((c) => ((c.weight ?? 1) / totalWeight) * contentWidth);

  const rowHeight = (cells: string[]): number => {
    const max = Math.max(
      ...cells.map((text, i) =>
        doc.heightOfString(text, { width: widths[i] - ROW_PADDING * 2 }),
      ),
    );
    return max + ROW_PADDING * 2;
  };

  const drawRow = (cells: string[], y: number, bold: boolean): number => {
    const h = rowHeight(cells);
    if (bold) {
      doc.rect(left, y, contentWidth, h).fill(HEADER_FILL);
    }
    doc
      .font(bold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(9)
      .fillColor("#111827");
    let x = left;
    cells.forEach((text, i) => {
      doc.text(text, x + ROW_PADDING, y + ROW_PADDING, {
        width: widths[i] - ROW_PADDING * 2,
      });
      x += widths[i];
    });
    doc.moveTo(left, y + h).lineTo(right, y + h).strokeColor(BORDER).stroke();
    return y + h;
  };

  const bottom = doc.page.height - doc.page.margins.bottom;
  let y = doc.y;

  const header = columns.map((c) => c.header);
  y = drawRow(header, y, true);

  for (const row of rows) {
    const cells = columns.map((c) => formatCell(c.value(row)));
    if (y + rowHeight(cells) > bottom) {
      doc.addPage();
      y = doc.page.margins.top;
      y = drawRow(header, y, true); // repeat the header on each page
    }
    y = drawRow(cells, y, false);
  }

  if (rows.length === 0) {
    doc.font("Helvetica-Oblique").fontSize(9).fillColor("#6b7280");
    doc.text("No rows.", left, y + ROW_PADDING);
  }

  doc.end();
  return done;
};

// ── Unified ──────────────────────────────────────────────────────────────────

export type RenderedReport = {
  body: string | Buffer;
  mime: string;
  extension: "csv" | "pdf";
};

/** Render `rows` in the requested format from the shared column spec. */
export const renderReport = async <T>(
  format: ExportFormat,
  rows: T[],
  columns: ReportColumn<T>[],
  opts: { title: string; subtitle?: string },
): Promise<RenderedReport> => {
  if (format === "pdf") {
    return {
      body: await renderPdf(rows, columns, opts),
      mime: "application/pdf",
      extension: "pdf",
    };
  }
  return {
    body: await renderCsv(rows, columns),
    mime: "text/csv; charset=utf-8",
    extension: "csv",
  };
};
