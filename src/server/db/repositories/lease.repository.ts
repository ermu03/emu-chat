import type Database from 'better-sqlite3';
import type { CoordinatorLeaseEntity } from './schema-types.js';

export class LeaseRepository {
  constructor(private db: Database.Database) {}

  findByScope(
    scopeType: CoordinatorLeaseEntity['scope_type'],
    scopeId: string
  ): CoordinatorLeaseEntity | null {
    const row = this.db
      .prepare('SELECT * FROM coordinator_leases WHERE scope_type = ? AND scope_id = ?')
      .get(scopeType, scopeId) as CoordinatorLeaseEntity | undefined;
    return row ?? null;
  }

  acquire(
    scopeType: CoordinatorLeaseEntity['scope_type'],
    scopeId: string,
    ownerId: string,
    leaseToken: string,
    ttlMs: number
  ): boolean {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    const nowIso = now.toISOString();

    const res = this.db
      .prepare(
        `INSERT INTO coordinator_leases (
          scope_type, scope_id, owner_id, lease_token, expires_at,
          heartbeat_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (scope_type, scope_id) DO UPDATE SET
          owner_id = excluded.owner_id,
          lease_token = excluded.lease_token,
          expires_at = excluded.expires_at,
          heartbeat_at = excluded.heartbeat_at,
          updated_at = excluded.updated_at
        WHERE coordinator_leases.expires_at < ?
           OR (coordinator_leases.owner_id = excluded.owner_id AND coordinator_leases.lease_token = excluded.lease_token)`
      )
      .run(
        scopeType,
        scopeId,
        ownerId,
        leaseToken,
        expiresAt,
        nowIso,
        nowIso,
        nowIso,
        nowIso
      );

    return res.changes > 0;
  }

  renew(
    scopeType: CoordinatorLeaseEntity['scope_type'],
    scopeId: string,
    leaseToken: string,
    ttlMs: number
  ): boolean {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    const nowIso = now.toISOString();

    const res = this.db
      .prepare(
        `UPDATE coordinator_leases
         SET expires_at = ?, heartbeat_at = ?, updated_at = ?
         WHERE scope_type = ? AND scope_id = ? AND lease_token = ? AND expires_at > ?`
      )
      .run(expiresAt, nowIso, nowIso, scopeType, scopeId, leaseToken, nowIso);

    return res.changes > 0;
  }

  release(
    scopeType: CoordinatorLeaseEntity['scope_type'],
    scopeId: string,
    leaseToken: string
  ): boolean {
    const res = this.db
      .prepare(
        `DELETE FROM coordinator_leases
         WHERE scope_type = ? AND scope_id = ? AND lease_token = ?`
      )
      .run(scopeType, scopeId, leaseToken);

    return res.changes > 0;
  }

  releaseAllByOwner(ownerId: string): number {
    const res = this.db
      .prepare('DELETE FROM coordinator_leases WHERE owner_id = ?')
      .run(ownerId);
    return res.changes;
  }
}
