import { supabase } from '../db/supabase';
import { logger } from '../utils/logger';

export interface AuditEntry {
  id: string;
  actor_id: string;
  action: string;
  target_id: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
}

export class AuditService {
  /**
   * Record a bot-admin action. This is fire-and-forget for the caller —
   * commands should not fail just because the audit insert failed, but
   * every failure is logged loudly so it's visible in the panel console.
   */
  async log(
    actorId: string,
    action: string,
    targetId?: string,
    details?: Record<string, unknown>
  ): Promise<void> {
    const { error } = await supabase.from('admin_audit_log').insert({
      actor_id: actorId,
      action,
      target_id: targetId ?? null,
      details: details ?? null,
    });

    if (error) {
      logger.error(
        `[AuditService] Failed to write audit entry (${action} by ${actorId} on ${targetId ?? 'n/a'}):`,
        error.message
      );
    }
  }

  /**
   * Fetch recent audit entries, most recent first.
   * Used by `*premium-audit`.
   */
  async recent(limit = 30): Promise<AuditEntry[]> {
    const { data, error } = await supabase
      .from('admin_audit_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      logger.error('[AuditService] recent query failed:', error.message);
      return [];
    }
    return (data ?? []) as AuditEntry[];
  }

  /**
   * Fetch audit entries for a specific target (server ID or user ID).
   * Used by `*premium-history`.
   */
  async forTarget(targetId: string, limit = 30): Promise<AuditEntry[]> {
    const { data, error } = await supabase
      .from('admin_audit_log')
      .select('*')
      .eq('target_id', targetId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      logger.error('[AuditService] forTarget query failed:', error.message);
      return [];
    }
    return (data ?? []) as AuditEntry[];
  }

  /**
   * Fetch audit entries performed by a specific bot admin.
   * Useful for reviewing what a particular admin has done.
   */
  async forActor(actorId: string, limit = 30): Promise<AuditEntry[]> {
    const { data, error } = await supabase
      .from('admin_audit_log')
      .select('*')
      .eq('actor_id', actorId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      logger.error('[AuditService] forActor query failed:', error.message);
      return [];
    }
    return (data ?? []) as AuditEntry[];
  }
}

export const auditService = new AuditService();
