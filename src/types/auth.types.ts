export interface SignInBody {
  email: string;
  password: string;
}

export interface ForgotPasswordBody {
  email: string;
}

export interface SignUpBody {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
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
