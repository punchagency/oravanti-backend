export interface UpdateProfileBody {
  firstName?: string;
  lastName?: string;
  phone?: string;
  jobTitle?: string;
  barNumber?: string;
}

export interface UpsertFirmInfoBody {
  firmName: string;
  firmEmail: string;
  firmPhone?: string;
  address?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  website?: string;
  taxId?: string;
}
