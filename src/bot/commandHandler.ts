import { Message, PermissionsBitField } from 'discord.js';
import { config } from '../config';
import { permissionService } from '../services/permissionService';
import { entitlementService } from '../services/entitlementService';
import { logger } from '../utils/logger';

export interface PrefixCommand {
  /** Primary command name, without the prefix. */
  name: string;
  /** Optional alternate names. */
  aliases?: string[];
  /** Short description shown in *help. */
  description: string;
  /**
   * If true, the command requires a row in `bot_admins` with active = true.
   * These are silently ignored for non-admins — the bot does not reveal the
   * command exists.
   */
  adminOnly?: boolean;
  /**
   * If true, the caller must be a guild admin: either a live Discord
   * Administrator in the guild OR a row in `guild_admins` for this guild.
   * Both gates require a guild context, so this implies requireGuild.
   */
  guildAdminOnly?: boolean;
  /**
   * Discord permission bits required in the guild. Checked live from the
   * member's permissions. Independent of guildAdminOnly.
   */
  requiredPermissions?: bigint;
  /**
   * If true, gates the command behind premium (Server Premium OR
   * User Premium with Administrator). Uses guildHasPremiumAccess.
   */
  requiresPremium?: boolean;
  /**
   * If true (default), the command only works in guild channels.
   * Set false only for commands like *help and *ping.
   */
  requireGuild?: boolean;
  /** Command implementation. Receives the message and argv (already split). */
  execute: (message: Message, args: string[]) => Promise<void>;
}

class CommandHandlerImpl {
  private commands = new Map<string, PrefixCommand>();

  register(cmd: PrefixCommand): void {
    if (this.commands.has(cmd.name)) {
      logger.warn(`[CommandHandler] Duplicate command name: ${cmd.name}`);
    }
    this.commands.set(cmd.name, cmd);
    for (const alias of cmd.aliases ?? []) {
      if (this.commands.has(alias)) {
        logger.warn(`[CommandHandler] Duplicate alias: ${alias} (on ${cmd.name})`);
      }
      this.commands.set(alias, cmd);
    }
  }

  registerAll(cmds: PrefixCommand[]): void {
    for (const cmd of cmds) this.register(cmd);
    logger.info(`[CommandHandler] Registered ${this.commands.size} command entries.`);
  }

  /**
   * Returns true if the command is adminOnly. Used by *help to decide
   * whether to show the "Bot admin only" section to the caller.
   */
  isAdminOnly(name: string): boolean {
    return this.commands.get(name)?.adminOnly === true;
  }

  /** Exposed for *help to iterate all commands (deduplicated by name). */
  listPublic(): PrefixCommand[] {
    const seen = new Set<string>();
    const out: PrefixCommand[] = [];
    for (const cmd of this.commands.values()) {
      if (seen.has(cmd.name)) continue;
      seen.add(cmd.name);
      if (!cmd.adminOnly) out.push(cmd);
    }
    return out;
  }

  listAdmin(): PrefixCommand[] {
    const seen = new Set<string>();
    const out: PrefixCommand[] = [];
    for (const cmd of this.commands.values()) {
      if (seen.has(cmd.name)) continue;
      seen.add(cmd.name);
      if (cmd.adminOnly) out.push(cmd);
    }
    return out;
  }

  async handle(message: Message): Promise<void> {
    // Ignore bots, system messages, and messages without the prefix.
    if (message.author.bot) return;
    if (!message.content.startsWith(config.prefix)) return;

    const withoutPrefix = message.content.slice(config.prefix.length).trim();
    if (!withoutPrefix) return;

    const parts = withoutPrefix.split(/\s+/);
    const name = parts.shift()!.toLowerCase();
    const args = parts;

    const cmd = this.commands.get(name);
    if (!cmd) return;

    // ---- Gate 1: guild context ------------------------------------------
    const requireGuild = cmd.requireGuild !== false;
    if (requireGuild && !message.guild) {
      // No reply — avoids leaking command names in DMs.
      return;
    }

    // ---- Gate 2: bot admin ----------------------------------------------
    if (cmd.adminOnly) {
      const isAdmin = await permissionService.isBotAdmin(message.author.id);
      if (!isAdmin) {
        // Silently ignore. Do not reply, do not react.
        return;
      }
    }

    // ---- Gate 3: guild admin --------------------------------------------
    if (cmd.guildAdminOnly) {
      if (!message.guild || !message.member) return;
      const hasDiscordAdmin = message.member.permissions.has(
        PermissionsBitField.Flags.Administrator
      );
      const inTable = await permissionService.isGuildAdmin(
        message.author.id,
        message.guild.id
      );
      if (!hasDiscordAdmin && !inTable) {
        await message
          .reply('You need Administrator permission or guild-admin status to use this command.')
          .catch(() => {});
        return;
      }
    }

    // ---- Gate 4: Discord permission bits --------------------------------
    if (cmd.requiredPermissions) {
      if (!message.member?.permissions.has(cmd.requiredPermissions)) {
        await message
          .reply('You lack the required Discord permissions for this command.')
          .catch(() => {});
        return;
      }
    }

    // ---- Gate 5: premium ------------------------------------------------
    if (cmd.requiresPremium) {
      if (!message.guild) return;
      const hasPremium = await entitlementService.guildHasPremiumAccess(
        message.guild.id,
        message.member ?? undefined
      );
      if (!hasPremium) {
        await message
          .reply('This feature requires Server Premium or User Premium. Run `*premium` for details.')
          .catch(() => {});
        return;
      }
    }

    // ---- Execute --------------------------------------------------------
    try {
      await cmd.execute(message, args);
    } catch (err: any) {
      logger.error(
        `[CommandHandler] Command "${cmd.name}" failed for ${message.author.id}:`,
        err?.message ?? err
      );
      await message
        .reply('An error occurred while running that command.')
        .catch(() => {});
    }
  }
}

export const commandHandler = new CommandHandlerImpl();
