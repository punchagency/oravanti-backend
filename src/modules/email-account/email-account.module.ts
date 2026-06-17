import { DnsService } from "../../utils/dns.service";
import { CommonValidation } from "../../validation/common.validation";
import { EmailAccountController } from "./email-account.controller";
import { EmailAccountRouter } from "./email-account.routes";
import { EmailAccountService } from "./email-account.service";

export class EmailAccountModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const commonValidation = new CommonValidation();
    const dnsService = new DnsService();
    const service = new EmailAccountService(dnsService);
    const controller = new EmailAccountController(service);
    const router = new EmailAccountRouter(controller, commonValidation);
    this.router = router.router;
    this.path = router.path;
  }
}
