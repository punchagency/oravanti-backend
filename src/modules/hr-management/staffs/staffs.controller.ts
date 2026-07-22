import { StaffService } from "./staffs.service";

export class StaffController {
  private staffService: StaffService;

  constructor(staffService: StaffService) {
    this.staffService = staffService;
  }

  // All routes currently commented out in routes file
}
