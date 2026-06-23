/**
 * Document scan provider.
 *
 * When a client uploads a document through the questionnaire portal, it is scanned
 * for errors/risks by an AI service. That service is not built yet, so this ships a
 * stub that returns deterministic dummy findings. Swap `StubDocumentScanProvider`
 * for a real implementation behind the same interface when the AI service is ready.
 */

export type DocumentScanSeverity = "critical" | "high" | "medium" | "low";

export interface DocumentScanFinding {
  severity: DocumentScanSeverity;
  title: string;
  description: string;
  affectedField?: string;
}

export interface DocumentScanResult {
  status: "clean" | "issues_found";
  findings: DocumentScanFinding[];
}

export interface DocumentScanInput {
  fileId: string;
  originalFilename: string;
  mimeType: string;
  storagePath: string;
}

export interface DocumentScanProvider {
  scan(input: DocumentScanInput): Promise<DocumentScanResult>;
}

export class StubDocumentScanProvider implements DocumentScanProvider {
  async scan(input: DocumentScanInput): Promise<DocumentScanResult> {
    // Deterministic pseudo-result derived from the file id so repeated scans of the
    // same file are stable and demos are reproducible. ~1 in 3 files flags an issue.
    const seed = input.fileId
      .split("")
      .reduce((acc, ch) => acc + ch.charCodeAt(0), 0);

    if (seed % 3 !== 0) {
      return { status: "clean", findings: [] };
    }

    const findings: DocumentScanFinding[] =
      seed % 2 === 0
        ? [
            {
              severity: "high",
              title: "Passport nearing expiry",
              description:
                "The uploaded passport appears to expire within 6 months. USCIS may require a passport valid for the full requested period. (Stubbed AI finding.)",
              affectedField: "passport_expiry",
            },
          ]
        : [
            {
              severity: "critical",
              title: "Missing required document",
              description:
                "A required supporting document for this matter type does not appear to be included in the upload. (Stubbed AI finding.)",
            },
          ];

    return { status: "issues_found", findings };
  }
}

export const documentScanProvider: DocumentScanProvider =
  new StubDocumentScanProvider();
