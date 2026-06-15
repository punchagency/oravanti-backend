import { Resolver } from "dns/promises";

export class DnsService {
  private resolver: Resolver;
  /**
   * Initializes the DNS resolver with fallback public servers
   * @param {string[]} [customServers] - Optional array of DNS server IPs
   */
  constructor(customServers: string[] = ["8.8.8.8", "1.1.1.1"]) {
    this.resolver = new Resolver();
    this.resolver.setServers(customServers);
  }

  /**
   * Private helper to handle standard DNS errors gracefully
   * @private
   */
  async _safeLookup<T>(lookupFn: () => Promise<T>): Promise<T | any[]> {
    try {
      return await lookupFn();
    } catch (error: any) {
      // Return empty results if record doesn't exist, instead of throwing
      if (error.code === "ENODATA" || error.code === "ENOTFOUND") {
        return [];
      }
      // Re-throw genuine network/connection errors (like ECONNREFUSED)
      throw error;
    }
  }

  /**
   * Resolves Mail Exchange (MX) records sorted by priority
   * @param {string} domain
   */
  async getMX(domain: string) {
    const records = await this._safeLookup(() =>
      this.resolver.resolveMx(domain),
    );
    return records.sort(
      (a: { priority: number }, b: { priority: number }) =>
        a.priority - b.priority,
    );
  }

  /**
   * Resolves IPv4 addresses (A records)
   * @param {string} domain
   */
  async getA(domain: string) {
    return this._safeLookup(() => this.resolver.resolve4(domain));
  }

  /**
   * Resolves IPv6 addresses (AAAA records)
   * @param {string} domain
   */
  async getAAAA(domain: string) {
    return this._safeLookup(() => this.resolver.resolve6(domain));
  }

  /**
   * Resolves Text records (TXT) flattened into a clean string array
   * @param {string} domain
   */
  async getTXT(domain: string) {
    const records = await this._safeLookup(() =>
      this.resolver.resolveTxt(domain),
    );
    return records.flat();
  }

  /**
   * Resolves Canonical Name records (CNAME)
   * @param {string} domain
   */
  async getCNAME(domain: string) {
    return this._safeLookup(() => this.resolver.resolveCname(domain));
  }

  /**
   * Resolves Name Servers (NS records)
   * @param {string} domain
   */
  async getNS(domain: string) {
    return this._safeLookup(() => this.resolver.resolveNs(domain));
  }

  /**
   * Aggregates multiple lookups into a single profile object
   * @param {string} domain
   */
  async getAllRecords(domain: string) {
    const [mx, a, aaaa, txt, cname, ns] = await Promise.all([
      this.getMX(domain),
      this.getA(domain),
      this.getAAAA(domain),
      this.getTXT(domain),
      this.getCNAME(domain),
      this.getNS(domain),
    ]);

    return { domain, mx, a, aaaa, txt, cname, ns };
  }
}
