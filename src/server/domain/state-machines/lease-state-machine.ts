export type LeaseScope = "global" | "conversation";

export interface LeaseClaim {
  scopeType: LeaseScope;
  scopeId: string;
  ownerId: string;
  leaseToken: string;
  acquiredAt: number;
  ttlMs: number;
}

export function isLeaseExpired(lease: { expires_at: string }): boolean {
  return new Date(lease.expires_at).getTime() <= Date.now();
}
