export type StaffRole = 'admin' | 'attorney' | 'senior_paralegal' | 'paralegal' | 'junior_paralegal';
export type StaffStatus = 'active' | 'inactive' | 'on_leave';

export interface AddStaffBody {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  role: StaffRole;
  teamId?: string;
  maxCaseload: number;
  startDate: string;
}

export interface UpdateStaffBody {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  role?: StaffRole;
  status?: StaffStatus;
  maxCaseload?: number;
}

export interface CreateTeamBody {
  name: string;
  leadId?: string;
  description?: string;
  maxCaseload?: number;
}

export interface UpdateTeamBody {
  name?: string;
  leadId?: string;
  description?: string;
  maxCaseload?: number;
}

export type FilingType = 'I-130' | 'I-485' | 'I-765' | 'I-140' | 'N-400' | 'I-131';
export type UrgencyLevel = 'normal' | 'urgent' | 'critical';
export type AssignmentType = 'internal_team' | 'external_contractor';

export interface AssignCaseBody {
  assignmentType: AssignmentType;
  filingType: FilingType;
  urgencyLevel: UrgencyLevel;
  teamId?: string;
  contractorId?: string;
}
