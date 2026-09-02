// PLAN LIMITS — the quotas usage metering enforces per plan.
// ------------------------------------------------------------------
//   monthly:   requests allowed per calendar month (UTC). null = unlimited.
//   perMinute: per-minute rate limit.                     null = unlimited.
// These mirror the numbers shown on the Billing page. A user's `plan` column
// (default 'free') selects the row; unknown plans fall back to Free.

export const PLAN_LIMITS = {
  free: { label: 'Free', monthly: 2500, perMinute: 5 },
  pro: { label: 'Pro', monthly: 100000, perMinute: 120 },
  business: { label: 'Business', monthly: 500000, perMinute: 400 },
  enterprise: { label: 'Enterprise', monthly: null, perMinute: null },
};

export function limitsFor(plan) {
  return PLAN_LIMITS[plan] || PLAN_LIMITS.free;
}
