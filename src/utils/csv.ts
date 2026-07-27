/**
 * Minimal RFC 4180 CSV serialisation.
 *
 * Hand-rolled rather than pulling a dependency: the export endpoints need
 * nothing beyond correct quoting. A field is quoted when it contains a comma,
 * quote, or newline, and embedded quotes are doubled.
 */

const escapeField = (value: unknown): string => {
  if (value == null) return "";
  const s =
    value instanceof Date ? value.toISOString() : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export type CsvColumn<T> = {
  header: string;
  value: (row: T) => unknown;
};

/**
 * Build a CSV document from rows and a column spec. A leading BOM is included so
 * Excel opens UTF-8 (accents, non-Latin names) correctly.
 */
export const toCsv = <T>(rows: T[], columns: CsvColumn<T>[]): string => {
  const header = columns.map((c) => escapeField(c.header)).join(",");
  const body = rows.map((row) =>
    columns.map((c) => escapeField(c.value(row))).join(","),
  );
  return `﻿${[header, ...body].join("\r\n")}\r\n`;
};
