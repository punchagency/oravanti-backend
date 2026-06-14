export interface DomainVerificationRecord {
  type: "CNAME" | "TXT" | "MX";
  host: string;
  value: string;
}

export interface ESPAdapter {
  registerDomain(
    domain: string,
  ): Promise<{ id: string; records: DomainVerificationRecord[] }>;
  verifyDomain(espDomainId: string): Promise<{ verified: boolean }>;
  sendEmail(data: {
    from: string;
    to: string;
    subject: string;
    html: string;
  }): Promise<void>;
}
