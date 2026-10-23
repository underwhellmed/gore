import { supabase } from '../db/supabase';
import { logger } from '../utils/logger';

export class PermissionService {
  /**
   * Bot administrator check. This is the SECURITY BOUNDARY for every `*`
   * command that is not a normal guild-user command. Never trust the prefix,
   * a role name, a hardcoded ID, or a cached value — only this query.
   */
  async isBotAdmin(discordUserId: string): Promise<boolean> {
    const { data, error } = await supabase
      .from('bot_admins')
      .select('discord_user_id')
      .eq('discord_user_id', discordUserId)
      .eq('active', true)
      .maybeSingle();

    if (error) {
      logger.error('[PermissionService] isBotAdmin query failed:', error.message);
      return false; // fail closed
    }
    return data !== null;
  }

  /**
   * Guild administrator check. Used for commands that modify a server's
   * configuration. A user must have a row in `guild_admins` for this guild.
   * Discord's Administrator permission alone is NOT sufficient — the guild
   * admin table is the source of truth once synced.
   */
  async isGuildAdmin(discordUserId: string, guildId: string): Promise<boolean> {
    const { data, error } = await supabase
      .from('guild_admins')
      .select('user_id')
      .eq('guild_id', guildId)
      .eq('user_id', discordUserId)
      .maybeSingle();

    if (error) {
      logger.error('[PermissionService] isGuildAdmin query failed:', error.message);
      return false; // fail closed
    }
    return data !== null;
  }

  /**
   * Sync a guild's administrators into Supabase. Called on `guildCreate`
   * and on startup for every guild the bot is in. This is what makes
   * `isGuildAdmin` fast — the bot refreshes the table, checks read it.
   */
  async syncGuildAdmins(guildId: string, adminUserIds: string[]): Promise<void> {
    const { error: delError } = await supabase
      .from('guild_admins')
      .delete()
      .eq('guild_id', guildId);

    if (delError) {
      logger.error(`[PermissionService] Failed to clear guild_admins for ${guildId}:`, delError.message);
      return;
    }

    if (adminUserIds.length === 0) return;

    const rows = adminUserIds.map((user_id) => ({ guild_id: guildId, user_id }));
    const { error: insError } = await supabase.from('guild_admins').insert(rows);

    if (insError) {
      logger.error(`[PermissionService] Failed to insert guild_admins for ${guildId}:`, insError.message);
      return;
    }

    logger.info(`[PermissionService] Synced ${rows.length} admins for guild ${guildId}`);
  }

  /**
   * Remove all guild_admin rows for a guild. Called on `guildDelete`.
   */
  async clearGuildAdmins(guildId: string): Promise<void> {
    const { error } = await supabase
      .from('guild_admins')
      .delete()
      .eq('guild_id', guildId);
    if (error) {
      logger.error(`[PermissionService] Failed to clear guild_admins for ${guildId}:`, error.message);
    }
  }
}

export const permissionService = new PermissionService();
