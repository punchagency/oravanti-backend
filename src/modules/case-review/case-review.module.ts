import { CaseReviewController } from "./case-review.controller";
import { CaseReviewRouter } from "./case-review.routes";
import { CaseReviewService } from "./case-review.service";

export class CaseReviewModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const service = new CaseReviewService();
    const controller = new CaseReviewController(service);
    const router = new CaseReviewRouter(controller);
    this.router = router.router;
    this.path = router.path;
  }
}
