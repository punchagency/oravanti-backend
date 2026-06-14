import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { generateUserDEK } from "../../utils/cryptoUtils";

export const cryptoKeyPlugin = () => {
  return {
    id: "crypto-key-plugin",
    schema: {
      user: {
        fields: {
          encryptedDEK: { type: "string", required: false },
          dekIv: { type: "string", required: false },
          dekTag: { type: "string", required: false },
        },
      },
    },
    hooks: {
      before: [
        {
          matcher: (context) => {
            return context.path === "/sign-up/email";
          },
          handler: createAuthMiddleware(async (ctx) => {
            const cryptoKeys = generateUserDEK();
            return {
              context: {
                ...ctx,
                body: {
                  ...(ctx.body as Record<string, unknown>),
                  ...cryptoKeys,
                },
              },
            };
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
};
