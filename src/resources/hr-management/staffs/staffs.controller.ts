import { StaffService } from "./staffs.service";

export class StaffController {
  private staffService: StaffService;

  constructor(staffService: StaffService) {
    this.staffService = staffService;
  }

  //   getAll = asyncWrap(async (req: AuthRequest, res: Response) => {
  //     const result = await this.staffService.getAllStaff(req.organizationId!);
  //     res.status(200).json(result);
  //   });
  //
  //   getById = asyncWrap(async (req: AuthRequest, res: Response) => {
  //     const result = await this.staffService.getStaffById(
  //       req.params.id as string,
  //       req.organizationId!,
  //     );
  //     if (!result) {
  //       throw new NotFoundError("Staff member not found");
  //     }
  //     res.status(200).json(result);
  //   });
  //
  //   addStaff = asyncWrap(async (req: AuthRequest, res: Response) => {
  //     const result = await this.staffService.addStaff({
  //       ...req.body,
  //       organizationId: req.organizationId!,
  //     });
  //     res.status(201).json({ message: "Staff member added", staff: result });
  //   });
  //
  //   updateStaff = asyncWrap(async (req: AuthRequest, res: Response) => {
  //     const result = await this.staffService.updateStaff(
  //       req.params.id as string,
  //       req.organizationId!,
  //       req.body as UpdateStaffBody,
  //     );
  //     if (!result) {
  //       throw new NotFoundError("Staff member not found");
  //     }
  //     res.status(200).json({ message: "Staff member updated", staff: result });
  //   });
  //
  //   deleteStaff = asyncWrap(async (req: AuthRequest, res: Response) => {
  //     const result = await this.staffService.deleteStaff(
  //       req.params.id as string,
  //       req.organizationId!,
  //     );
  //     if (!result) {
  //       throw new NotFoundError("Staff member not found");
  //     }
  //     res.status(200).json({ message: "Staff member deleted" });
  //   });
}
