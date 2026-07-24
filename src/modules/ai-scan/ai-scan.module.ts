import { AiScanController } from "./ai-scan.controller";
import { AiScanRouter } from "./ai-scan.routes";

export class AiScanModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const controller = new AiScanController();
    const router = new AiScanRouter(controller);
    this.router = router.router;
    this.path = router.path;
  }
}
