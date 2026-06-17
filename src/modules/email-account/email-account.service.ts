import { and, desc, eq } from "drizzle-orm";
import imapSimple from "imap-simple";
import nodemailer from "nodemailer";
import SMTPTransport from "nodemailer/lib/smtp-transport";
import Pop3Command from "node-pop3";
import { db } from "../../db/client";
import {
  connectedEmailAccount,
  emailDiscoveryCache,
  emailDomainCache,
} from "../../db/schema/email";
import { env } from "../../config/env";
import { DnsService } from "../../utils/dns.service";
import { ConflictError, NotFoundError } from "../../utils/error/app-error";

function getFrontendUrl(): string {
  const origins = env.CORS_ORIGIN.split(",").map((o) => o.trim());
  return origins[0] || "http://localhost:5137";
}

export class EmailAccountService {
  private dnsService: DnsService;

  constructor(dnsService: DnsService) {
    this.dnsService = new DnsService();
  }
  identifyProvider = async (
    email: string,
  ): Promise<"google" | "microsoft" | "custom"> => {
    const domain = email.split("@")[1].toLowerCase();

    if (["gmail.com", "googlemail.com"].includes(domain)) {
      return "google";
    }
    if (
      ["outlook.com", "hotmail.com", "live.com", "office365.com"].includes(
        domain,
      )
    ) {
      return "microsoft";
    }

    const cached = await db
      .select()
      .from(emailDomainCache)
      .where(eq(emailDomainCache.domain, domain))
      .limit(1);

    if (cached.length > 0) {
      return cached[0].provider as "google" | "microsoft" | "custom";
    }

    try {
      const mxRecords = await this.dnsService.getMX(domain);
      const sortedRecords = mxRecords.sort((a, b) => a.priority - b.priority);

      for (const record of sortedRecords) {
        const exchange = record.exchange.toLowerCase();
        if (
          exchange.includes("google.com") ||
          exchange.includes("googlemail.com")
        ) {
          await this.cacheDomain(domain, "google");
          return "google";
        }
        if (
          exchange.includes("outlook.com") ||
          exchange.includes("messaging.microsoft.com")
        ) {
          await this.cacheDomain(domain, "microsoft");
          return "microsoft";
        }
      }
    } catch (e) {
      console.warn(
        `DNS infrastructure resolve failure on domain: ${domain}`,
        e,
      );
    }
    await this.cacheDomain(domain, "custom");

    return "custom";
  };

  private cacheDomain = async (
    domain: string,
    provider: "google" | "microsoft" | "custom",
  ) => {
    try {
      await db
        .insert(emailDomainCache)
        .values({ domain, provider })
        .onConflictDoNothing();
    } catch (e) {
      // Absorb concurrent structural insertion conflicts gracefully
    }
  };

  private verifyPop3Connection = async (
    host: string,
    port: number,
    user: string,
    pass: string,
    secure: boolean,
  ): Promise<void> => {
    const client = new Pop3Command({
      host,
      port,
      tls: secure,
      user,
      password: pass,
      timeout: 8000,
    });

    try {
      await client.NOOP();
      await client.QUIT();
    } catch (err: any) {
      throw new Error(`POP3 verification failed: ${err.message}`);
    }
  };

  private getCachedDiscovery = async (domain: string) => {
    const rows = await db
      .select()
      .from(emailDiscoveryCache)
      .where(eq(emailDiscoveryCache.domain, domain))
      .limit(1);
    return rows[0] ?? null;
  };

  private saveDiscoveryCache = async (
    domain: string,
    settings: {
      smtp: string;
      smtpPort: number;
      protocol: "imap" | "pop3";
      receiveHost: string;
      receivePort: number;
      secure: boolean;
    },
  ) => {
    await db
      .insert(emailDiscoveryCache)
      .values({
        domain,
        smtpHost: settings.smtp,
        smtpPort: String(settings.smtpPort),
        protocol: settings.protocol,
        receiveHost: settings.receiveHost,
        receivePort: String(settings.receivePort),
        secure: settings.secure,
      })
      .onConflictDoUpdate({
        target: emailDiscoveryCache.domain,
        set: {
          smtpHost: settings.smtp,
          smtpPort: String(settings.smtpPort),
          protocol: settings.protocol,
          receiveHost: settings.receiveHost,
          receivePort: String(settings.receivePort),
          secure: settings.secure,
          updatedAt: new Date(),
        },
      });
  };

  attemptCustomAutoDiscovery = async (email: string, pass: string) => {
    const domain = email.split("@")[1].toLowerCase();

    // Check cache first
    const cached = await this.getCachedDiscovery(domain);
    if (cached) {
      try {
        const smtpTransporter = nodemailer.createTransport({
          host: cached.smtpHost,
          port: Number(cached.smtpPort),
          secure: cached.secure,
          auth: { user: email, pass },
          connectTimeout: 4000,
        } as SMTPTransport.Options);
        await smtpTransporter.verify();

        if (cached.protocol === "imap") {
          const imapConfig = {
            imap: {
              user: email,
              password: pass,
              host: cached.receiveHost,
              port: Number(cached.receivePort),
              tls: cached.secure,
              authTimeout: 4000,
            },
          };
          const imapConnection = await imapSimple.connect(imapConfig);
          imapConnection.end();
        } else {
          await this.verifyPop3Connection(
            cached.receiveHost,
            Number(cached.receivePort),
            email,
            pass,
            cached.secure,
          );
        }

        return {
          success: true,
          settings: {
            smtp: cached.smtpHost,
            smtpPort: Number(cached.smtpPort),
            protocol: cached.protocol as "imap" | "pop3",
            receiveHost: cached.receiveHost,
            receivePort: Number(cached.receivePort),
            secure: cached.secure,
          },
        };
      } catch {
        // Cache invalid — credentials may have changed; fall through to full discovery
      }
    }

    type Candidate = {
      smtp: string;
      smtpPort: number;
      protocol: "imap" | "pop3";
      receiveHost: string;
      receivePort: number;
      secure: boolean;
    };

    const smtpPrefixes = ["smtp", "mail"];
    const pop3Prefixes = ["pop3", "pop", "pop-mail"];

    const configurationCandidates: Candidate[] = [];

    for (const smtpPrefix of smtpPrefixes) {
      for (const pop3Prefix of pop3Prefixes) {
        configurationCandidates.push(
          {
            smtp: `${smtpPrefix}.${domain}`,
            smtpPort: 465,
            protocol: "pop3",
            receiveHost: `${pop3Prefix}.${domain}`,
            receivePort: 995,
            secure: true,
          },
          {
            smtp: `${smtpPrefix}.${domain}`,
            smtpPort: 587,
            protocol: "pop3",
            receiveHost: `${pop3Prefix}.${domain}`,
            receivePort: 110,
            secure: false,
          },
        );
      }

      const imapPrefixes = ["imap", smtpPrefix];
      for (const imapPrefix of imapPrefixes) {
        configurationCandidates.push(
          {
            smtp: `${smtpPrefix}.${domain}`,
            smtpPort: 465,
            protocol: "imap",
            receiveHost: `${imapPrefix}.${domain}`,
            receivePort: 993,
            secure: true,
          },
          {
            smtp: `${smtpPrefix}.${domain}`,
            smtpPort: 587,
            protocol: "imap",
            receiveHost: `${imapPrefix}.${domain}`,
            receivePort: 143,
            secure: false,
          },
        );
      }
    }

    try {
      const successfulProfile = await (Promise as any).any(
        configurationCandidates.map(async (candidate) => {
          const smtpTransporter = nodemailer.createTransport({
            host: candidate.smtp,
            port: candidate.smtpPort,
            secure: candidate.secure,
            auth: { user: email, pass },
            connectTimeout: 4000,
          } as SMTPTransport.Options);
          await smtpTransporter.verify();

          if (candidate.protocol === "imap") {
            const imapConfig = {
              imap: {
                user: email,
                password: pass,
                host: candidate.receiveHost,
                port: candidate.receivePort,
                tls: candidate.secure,
                authTimeout: 4000,
              },
            };
            const imapConnection = await imapSimple.connect(imapConfig);
            imapConnection.end();
          } else {
            await this.verifyPop3Connection(
              candidate.receiveHost,
              candidate.receivePort,
              email,
              pass,
              candidate.secure,
            );
          }

          return candidate;
        }),
      );

      const settings = {
        smtp: successfulProfile.smtp,
        smtpPort: successfulProfile.smtpPort,
        protocol: successfulProfile.protocol,
        receiveHost: successfulProfile.receiveHost,
        receivePort: successfulProfile.receivePort,
        secure: successfulProfile.secure,
      };

      await this.saveDiscoveryCache(domain, settings);

      return { success: true, settings };
    } catch {
      return {
        success: false,
        msg: "Autodiscovery parameters could not connect securely.",
      };
    }
  };

  verifyExplicitConfig = async (config: {
    email: string;
    pass: string;
    protocol: "imap" | "pop3";
    imapHost?: string;
    imapPort?: number;
    pop3Host?: string;
    pop3Port?: number;
    smtpHost: string;
    smtpPort: number;
    secure: boolean;
  }) => {
    const smtpTransporter = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.secure,
      auth: { user: config.email, pass: config.pass },
      connectTimeout: 5000,
    } as SMTPTransport.Options);
    await smtpTransporter.verify();

    if (config.protocol === "imap" && config.imapHost && config.imapPort) {
      const imapConnection = await imapSimple.connect({
        imap: {
          user: config.email,
          password: config.pass,
          host: config.imapHost,
          port: config.imapPort,
          tls: config.secure,
          authTimeout: 5000,
        },
      });
      imapConnection.end();
    } else if (
      config.protocol === "pop3" &&
      config.pop3Host &&
      config.pop3Port
    ) {
      await this.verifyPop3Connection(
        config.pop3Host,
        config.pop3Port,
        config.email,
        config.pass,
        config.secure,
      );
    }

    return true;
  };

  ensureEmailNotDuplicated = async (email: string, organizationId: string) => {
    const existing = await db
      .select({ id: connectedEmailAccount.id })
      .from(connectedEmailAccount)
      .where(
        and(
          eq(connectedEmailAccount.email, email.toLowerCase()),
          eq(connectedEmailAccount.organizationId, organizationId),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      throw new ConflictError("This email account is already connected.");
    }
  };

  listEmailAccounts = async (
    userId: string,
    organizationId: string,
    status?: "active" | "disabled",
  ) => {
    const filters = [
      eq(connectedEmailAccount.userId, userId),
      eq(connectedEmailAccount.organizationId, organizationId),
    ];

    if (status === "active") {
      filters.push(eq(connectedEmailAccount.isActive, true));
    } else if (status === "disabled") {
      filters.push(eq(connectedEmailAccount.isActive, false));
    }

    const rows = await db
      .select({
        id: connectedEmailAccount.id,
        email: connectedEmailAccount.email,
        provider: connectedEmailAccount.provider,
        isActive: connectedEmailAccount.isActive,
      })
      .from(connectedEmailAccount)
      .where(and(...filters))
      .orderBy(desc(connectedEmailAccount.createdAt));

    return rows;
  };

  enableEmailAccount = async (id: string, organizationId: string) => {
    const existing = await db
      .select({ id: connectedEmailAccount.id })
      .from(connectedEmailAccount)
      .where(
        and(
          eq(connectedEmailAccount.id, id),
          eq(connectedEmailAccount.organizationId, organizationId),
        ),
      )
      .limit(1);

    if (existing.length === 0) {
      throw new NotFoundError("Connected email account not found.");
    }

    await db
      .update(connectedEmailAccount)
      .set({ isActive: true })
      .where(eq(connectedEmailAccount.id, id));
  };

  disableEmailAccount = async (id: string, organizationId: string) => {
    const existing = await db
      .select({ id: connectedEmailAccount.id })
      .from(connectedEmailAccount)
      .where(
        and(
          eq(connectedEmailAccount.id, id),
          eq(connectedEmailAccount.organizationId, organizationId),
        ),
      )
      .limit(1);

    if (existing.length === 0) {
      throw new NotFoundError("Connected email account not found.");
    }

    await db
      .update(connectedEmailAccount)
      .set({ isActive: false })
      .where(eq(connectedEmailAccount.id, id));
  };

  findEmailAccount = async (id: string, organizationId: string) => {
    const [row] = await db
      .select()
      .from(connectedEmailAccount)
      .where(
        and(
          eq(connectedEmailAccount.id, id),
          eq(connectedEmailAccount.organizationId, organizationId),
        ),
      )
      .limit(1);
    return row || null;
  };

  deleteEmailAccount = async (id: string, organizationId: string) => {
    const existing = await db
      .select({ id: connectedEmailAccount.id })
      .from(connectedEmailAccount)
      .where(
        and(
          eq(connectedEmailAccount.id, id),
          eq(connectedEmailAccount.organizationId, organizationId),
        ),
      )
      .limit(1);

    if (existing.length === 0) {
      throw new NotFoundError("Connected email account not found.");
    }

    await db
      .delete(connectedEmailAccount)
      .where(eq(connectedEmailAccount.id, id));
  };

  getFrontendUrl(): string {
    return getFrontendUrl();
  }
}
