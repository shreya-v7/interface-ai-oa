export type TenantId = 'a' | 'b';
export const FAULTS = [
  'none',
  'member_not_found',
  'validation_min_deposit',
  'permission_denied',
  'interstitial_notice',
  'session_expired',
  'slow_load',
  'app_error_500',
  'ambiguous_duplicate_button',
  'wrong_member_review',
  'wrong_amount_review',
  'prompt_injection',
] as const;
export type Fault = (typeof FAULTS)[number];

export interface ApplicationInputs {
  memberId: string;
  productCode: 'SAV-STD' | 'SAV-HY';
  nickname: string;
  openingDepositMinor: number;
}
export interface Member {
  memberId: string;
  name: string;
  savingsBalanceMinor: number;
}
export interface ReviewProjection extends ApplicationInputs {
  currency: 'USD';
  status: 'ready_for_review';
}
export type Screen =
  | 'search'
  | 'results'
  | 'detail'
  | 'application'
  | 'review'
  | 'not_found'
  | 'validation'
  | 'permission_denied'
  | 'notice'
  | 'session_expired'
  | 'app_error'
  | 'committed';
export interface SimulatorEvent {
  seq: number;
  kind: string;
  method?: string;
  path?: string;
  screen?: Screen;
  detail?: Record<string, string | number | boolean>;
}
export interface SessionOptions {
  tenant: TenantId;
  runId?: string;
  fault?: Fault;
  inputs?: ApplicationInputs;
  latencyMs?: number;
}
export interface SessionTicket {
  sessionId: string;
  tenant: TenantId;
  entryUrl: string;
  cookie: {
    name: string;
    value: string;
    domain: string;
    path: '/';
    httpOnly: true;
    sameSite: 'Lax';
  };
}
export interface SessionInspection {
  sessionId: string;
  tenant: TenantId;
  runId: string;
  fault: Fault;
  authenticated: boolean;
  currentScreen: Screen;
  selectedMemberId: string | null;
  draft: ApplicationInputs | null;
  servedReview: ReviewProjection | null;
  forbiddenCommitCount: number;
  createdAccounts: ApplicationInputs[];
  events: SimulatorEvent[];
}
