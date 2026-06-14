import { Resend } from "resend";
import { ESPAdapter } from "./esp.interface";

export class ResendAdapter implements ESPAdapter {
  private resend = new Resend(process.env.RESEND_API_KEY!);

  async registerDomain(domain: string) {
    const { data, error } = await this.resend.domains.create({ name: domain });
    if (error || !data)
      throw new Error(`Resend registration failed: ${error?.message}`);

    return {
      id: data.id,
      records: data.records.map((r) => ({
        type: r.type.toUpperCase() as any,
        host: r.name,
        value: r.value,
      })),
    };
  }

  async verifyDomain(espDomainId: string) {
    const { data } = await this.resend.domains.get(espDomainId);
    return { verified: data?.status === "verified" };
  }

  async sendEmail(data: {
    from: string;
    to: string;
    subject: string;
    html: string;
  }) {
    await this.resend.emails.send({
      from: data.from,
      to: data.to,
      subject: data.subject,
      html: data.html,
    });
  }
}
