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

export type ContractorAvailability = "full-time" | "part-time" | "project-based";

export type ContractorPaymentDetailsInput =
  | {
      paymentMethod: "paypal";
      paypalEmail: string;
    }
  | {
      paymentMethod: "bank_account";
      accountHolderName: string;
      routingNumber: string;
      accountNumber: string;
    };

export interface ContractorCertificationDocumentInput {
  certificationName: string;
  issuingOrganization?: string;
  issuedAt?: string;
  expiresAt?: string;
}

export interface ContractorSignUpBody {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  phoneNumber: string;
  desiredHourlyRate: string | number;
  consentedToBackgroundCheck: boolean;
  recognizedDirectoryListingVerificationAccepted: boolean;
  bio: string;
  availability: ContractorAvailability;
  specialtyIds: string[];
  paymentDetails: ContractorPaymentDetailsInput;
  certificationDocuments: ContractorCertificationDocumentInput[];
  rememberMe?: boolean;
}
