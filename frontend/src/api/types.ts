export interface Paginated<T> {
  count: number;
  page: number;
  page_size: number;
  num_pages: number;
  results: T[];
}

export type DateDisplayMode = "AD" | "BS" | "AD_BS";

export interface Organization {
  id: number;
  name: string;
  code: string;
  currency: string;
  currency_symbol: string;
  locale: string;
  timezone: string;
  date_display_mode: DateDisplayMode;
  date_input_calendar: "AD" | "BS";
  logo: string | null;
}

export interface Membership {
  organization: number;
  organization_name: string;
  role: string;
  role_label: string;
}

export interface User {
  id: number;
  email: string;
  full_name: string;
  phone: string;
  date_display_mode: DateDisplayMode | "";
  is_superuser: boolean;
  must_change_password: boolean;
  default_organization: number | null;
  memberships: Membership[];
}

export interface Session {
  user: User;
  organization: Organization | null;
  role: string | null;
  permissions: string[];
}

export interface FiscalYear {
  id: number;
  name: string;
  code: string;
  label: string;
  start_date: string;
  start_date_bs: string;
  end_date: string;
  end_date_bs: string;
  period_type: string;
  status: "DRAFT" | "ACTIVE" | "CLOSING" | "CLOSED" | "REOPENED";
  status_label: string;
  opening_balance_status: string;
  closing_status: string;
  created_by_name: string | null;
  approved_by_name: string | null;
  approved_at: string | null;
  closed_by_name: string | null;
  closed_at: string | null;
  created_at: string;
  notes: string;
  periods?: AccountingPeriod[];
}

export interface AccountingPeriod {
  id: number;
  fiscal_year: number;
  fiscal_year_name: string;
  number: number;
  name: string;
  start_date: string;
  start_date_bs: string;
  end_date: string;
  end_date_bs: string;
  status: "OPEN" | "LOCKED";
  locked_by_name: string | null;
  locked_at: string | null;
  lock_reason: string;
  journal_count: number | null;
}

export interface Option {
  id: number;
  name?: string;
  code?: string;
  [key: string]: unknown;
}

export interface AuditEvent {
  id: number;
  created_at: string;
  date_bs: string;
  user_name: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  entity_label: string;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  reason: string;
  request_id: string;
}

export interface RelatedDocument {
  type: string;
  id: number;
  number: string;
  date: string | null;
  date_bs: string | null;
  status: string | null;
  amount: string | null;
  label: string;
  relation: string;
}
