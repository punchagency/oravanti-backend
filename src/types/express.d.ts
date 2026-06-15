import { User } from "better-auth";

declare global {
  namespace Express {
    interface Request {
      // Type definitions provided by Better Auth
      user?: User;
      // The decrypted raw 32-byte Data Encryption Key
      rawUserDEK?: Buffer;
    }
  }
}
