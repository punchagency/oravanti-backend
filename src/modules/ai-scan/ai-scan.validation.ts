import { z } from "zod";

export const rerunScanBodySchema = z.object({
  scenarioType: z.enum(["lead", "case"]),
  scenarioId: z.string().uuid(),
});

export type RerunScanBody = z.infer<typeof rerunScanBodySchema>;
