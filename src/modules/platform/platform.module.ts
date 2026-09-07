import { PlatformController } from "./platform.controller";
import { PlatformRouter } from "./platform.routes";

export class PlatformModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const router = new PlatformRouter(new PlatformController());
    this.router = router.router;
    this.path = router.path;
  }
}
