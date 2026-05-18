import { Response } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import { AddStaffBody, UpdateStaffBody } from '../../types/hr.types';
import * as staffService from '../../services/hr/staff.service';

export const getAll = async (req: AuthRequest, res: Response) => {
  try {
    const result = await staffService.getAllStaff(req.firmId!);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
};

export const getById = async (req: AuthRequest, res: Response) => {
  try {
    const result = await staffService.getStaffById(req.params.id as string, req.firmId!);
    if (!result) { res.status(404).json({ message: 'Staff member not found' }); return; }
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
};

export const addStaff = async (req: AuthRequest, res: Response) => {
  const { firstName, lastName, email, phone, role, teamId, startDate } = req.body as AddStaffBody;

  if (!firstName || !lastName || !email || !phone || !role || !teamId || !startDate) {
    res.status(400).json({ message: 'All fields are required' });
    return;
  }

  try {
    const result = await staffService.addStaff({ ...req.body, firmId: req.firmId! });
    res.status(201).json({ message: 'Staff member added', staff: result });
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
};

export const updateStaff = async (req: AuthRequest, res: Response) => {
  try {
    const result = await staffService.updateStaff(req.params.id as string, req.firmId!, req.body as UpdateStaffBody);
    if (!result) { res.status(404).json({ message: 'Staff member not found' }); return; }
    res.status(200).json({ message: 'Staff member updated', staff: result });
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
};

export const deleteStaff = async (req: AuthRequest, res: Response) => {
  try {
    const result = await staffService.deleteStaff(req.params.id as string, req.firmId!);
    if (!result) { res.status(404).json({ message: 'Staff member not found' }); return; }
    res.status(200).json({ message: 'Staff member deleted' });
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
};
