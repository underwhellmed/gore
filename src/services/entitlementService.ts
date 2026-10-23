import type { GuildMember } from 'discord.js';
import { supabase } from '../db/supabase';
import { logger } from '../utils/logger';

export type PremiumType = 'server' | 'user';
export type EntitlementStatus = 'active' | 'revoked' | 'expired';

export interface Entitlement {
  entitlement_id: string;
  premium_type: PremiumType;
  owner_id: string;
  status: EntitlementStatus;
  granted_by: string;
  granted_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
  payment_reference: string | null;
  grant_reason: string | null;
  revoke_reason: string | null;
}

export class EntitlementService {
  /**
   * Check if a guild has an active Server Premium entitlement.
   */
  async hasServerPremium(guildId: string): Promise<boolean> {
    const { data, error } = await supabase
      .from('entitlements')
      .select('entitlement_id')
      .eq('premium_type', 'server')
      .eq('owner_id', guildId)
      .eq('status', 'active')
      .maybeSingle();

    if (error) {
      logger.error('[EntitlementService] hasServerPremium failed:', error.message);
      return false; // fail closed
    }
    return data !== null;
  }

  /**
   * Check if a user has an active User Premium entitlement.
   * NOTE: This only checks entitlement ownership. It does NOT check whether
   * the user can activate premium in a specific guild. Use
   * `userPremiumUnlocksGuild` for that.
   */
  async hasUserPremiumEntitlement(userId: string): Promise<boolean> {
    const { data, error } = await supabase
      .from('entitlements')
      .select('entitlement_id')
      .eq('premium_type', 'user')
      .eq('owner_id', userId)
      .eq('status', 'active')
      .maybeSingle();

    if (error) {
      logger.error('[EntitlementService] hasUserPremiumEntitlement failed:', error.message);
      return false;
    }
    return data !== null;
  }

  /**
   * Full User Premium eligibility check for a specific guild.
   * Requires BOTH:
   *   1. The user has an active User Premium entitlement
   *   2. The user has Discord Administrator in this guild RIGHT NOW
   *
   * The Discord permission is rechecked live on every call — if they lose
   * Administrator, access stops immediately even though the entitlement
   * still exists.
   */
  async userPremiumUnlocksGuild(member: GuildMember): Promise<boolean> {
    if (!member.guild) return false;

    const hasEntitlement = await this.hasUserPremiumEntitlement(member.id);
    if (!hasEntitlement) return false;

    return member.permissions.has('Administrator');
  }

  /**
   * Unified gate for premium features. Returns true if EITHER:
   *   - The guild has Server Premium, OR
   *   - The interacting member has User Premium AND Administrator here.
   *
   * `member` is optional so non-member contexts (e.g. scheduled tasks)
   * can still check Server Premium only.
   */
  async guildHasPremiumAccess(guildId: string, member?: GuildMember): Promise<boolean> {
    if (await this.hasServerPremium(guildId)) return true;
    if (member) return this.userPremiumUnlocksGuild(member);
    return false;
  }

  // --------------------------------------------------------------------------
  // Grant / revoke operations — only called from bot-admin commands.
  // --------------------------------------------------------------------------

  async grantServerPremium(guildId: string, adminId: string, reason?: string): Promise<void> {
    await this.assertNotAlreadyActive('server', guildId);
    const { error } = await supabase.from('entitlements').insert({
      premium_type: 'server',
      owner_id: guildId,
      granted_by: adminId,
      grant_reason: reason ?? null,
    });
    if (error) throw new Error(`grantServerPremium failed: ${error.message}`);
    logger.info(`[EntitlementService] Granted Server Premium to ${guildId} by ${adminId}`);
  }

  async grantUserPremium(userId: string, adminId: string, reason?: string): Promise<void> {
    await this.assertNotAlreadyActive('user', userId);
    const { error } = await supabase.from('entitlements').insert({
      premium_type: 'user',
      owner_id: userId,
      granted_by: adminId,
      grant_reason: reason ?? null,
    });
    if (error) throw new Error(`grantUserPremium failed: ${error.message}`);
    logger.info(`[EntitlementService] Granted User Premium to ${userId} by ${adminId}`);
  }

  async revokeServerPremium(guildId: string, adminId: string, reason?: string): Promise<boolean> {
    return this.revoke('server', guildId, adminId, reason);
  }

  async revokeUserPremium(userId: string, adminId: string, reason?: string): Promise<boolean> {
    return this.revoke('user', userId, adminId, reason);
  }

  private async revoke(
    type: PremiumType,
    ownerId: string,
    adminId: string,
    reason?: string
  ): Promise<boolean> {
    const { data, error } = await supabase
      .from('entitlements')
      .update({
        status: 'revoked',
        revoked_at: new Date().toISOString(),
        revoked_by: adminId,
        revoke_reason: reason ?? null,
      })
      .eq('premium_type', type)
      .eq('owner_id', ownerId)
      .eq('status', 'active')
      .select('entitlement_id');

    if (error) {
      logger.error(`[EntitlementService] revoke ${type}/${ownerId} failed:`, error.message);
      return false;
    }
    if (!data || data.length === 0) return false;
    logger.info(`[EntitlementService] Revoked ${type} premium for ${ownerId} by ${adminId}`);
    return true;
  }

  private async assertNotAlreadyActive(type: PremiumType, ownerId: string): Promise<void> {
    const { data, error } = await supabase
      .from('entitlements')
      .select('entitlement_id')
      .eq('premium_type', type)
      .eq('owner_id', ownerId)
      .eq('status', 'active')
      .maybeSingle();

    if (error) throw new Error(`Entitlement pre-check failed: ${error.message}`);
    if (data) {
      throw new Error(
        `${type === 'server' ? 'Server' : 'User'} ${ownerId} already has an active ${type} premium entitlement.`
      );
    }
  }

  // --------------------------------------------------------------------------
  // Lookup helpers used by `*premium`, `*premium-list`, `*premium-audit`.
  // --------------------------------------------------------------------------

  async getActiveEntitlement(type: PremiumType, ownerId: string): Promise<Entitlement | null> {
    const { data, error } = await supabase
      .from('entitlements')
      .select('*')
      .eq('premium_type', type)
      .eq('owner_id', ownerId)
      .eq('status', 'active')
      .maybeSingle();

    if (error) {
      logger.error('[EntitlementService] getActiveEntitlement failed:', error.message);
      return null;
    }
    return data as Entitlement | null;
  }

  async listActiveEntitlements(limit = 30): Promise<Entitlement[]> {
    const { data, error } = await supabase
      .from('entitlements')
      .select('*')
      .eq('status', 'active')
      .order('granted_at', { ascending: false })
      .limit(limit);

    if (error) {
      logger.error('[EntitlementService] listActiveEntitlements failed:', error.message);
      return [];
    }
    return (data ?? []) as Entitlement[];
  }
}

export const entitlementService = new EntitlementService();
