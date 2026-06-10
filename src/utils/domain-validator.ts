const DOMAIN_REGEX = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]{2,63}$/i;

const BANNED_DOMAINS = new Set([
  "gmail.com",
  "yahoo.com",
  "outlook.com",
  "hotmail.com",
  "icloud.com",
  "aol.com",
  "amazon.com",
  "google.com",
  "microsoft.com",
  "apple.com",
  "meta.com",
  "localhost",
  "test.com",
  "example.com",
]);

export function validateCustomerDomain(
  domain: string,
): { valid: true } | { valid: false; reason: string } {
  const cleanedDomain = domain.trim().toLowerCase();

  if (!cleanedDomain) {
    return { valid: false, reason: "Domain cannot be empty." };
  }

  if (!DOMAIN_REGEX.test(cleanedDomain)) {
    return { valid: false, reason: "Invalid domain format. Do not include http:// or slashes." };
  }

  if (BANNED_DOMAINS.has(cleanedDomain)) {
    return { valid: false, reason: "You cannot register a public email provider or restricted system domain." };
  }

  return { valid: true };
}
