import {
  EmbedBuilder,
  Events,
  Guild,
  GuildMember,
  PartialGuildMember,
} from 'discord.js';
import { sendGuildLog } from '../commands/logging';
import { renderWelcome } from '../commands/welcome';
import { permissionService } from '../../services/permissionService';
import { supabase } from '../../db/supabase';
import { logger } from '../../utils/logger';

const COLOR_JOIN = 0x57f287; // green
const COLOR_LEAVE = 0xed4245; // red
const COLOR_JOIN_BOT = 0x5865f2; // blurple — bot added to a guild

// ===========================================================================
// GUILD MEMBER ADD
// 1. Send welcome message (if configured)
// 2. Send join log (if enabled)
// Both are independent — failure of one does not block the other.
// ===========================================================================
export const guildMemberAddEvent = {
  name: Events.GuildMemberAdd,
  once: false,
  async execute(member: GuildMember): Promise<void> {
    try {
      // ---- Welcome message ------------------------------------------------
      try {
        const { data: cfg } = await supabase
          .from('guild_configs')
          .select('welcome_channel_id, welcome_message')
          .eq('guild_id', member.guild.id)
          .maybeSingle();

        if (cfg?.welcome_channel_id && cfg?.welcome_message) {
          const channel = await member.guild.channels
            .fetch(cfg.welcome_channel_id)
            .catch(() => null);

          if (channel && channel.isTextBased()) {
            const rendered = renderWelcome(cfg.welcome_message, member);
            await channel.send(rendered).catch((err) =>
              logger.warn(
                `[guildMemberAdd] Welcome send failed in ${member.guild.id}:`,
                err?.message ?? err
              )
            );
          }
        }
      } catch (err: any) {
        logger.error('[guildMemberAdd] Welcome block threw:', err?.message ?? err);
      }

      // ---- Join log -------------------------------------------------------
      try {
        const accountAgeDays = Math.floor(
          (Date.now() - member.user.createdTimestamp) / 86_400_000
        );

        const embed = new EmbedBuilder()
          .setTitle('Member Joined')
          .setColor(COLOR_JOIN)
          .setAuthor({
            name: member.user.tag,
            iconURL: member.user.displayAvatarURL({ size: 64 }),
          })
          .setThumbnail(member.user.displayAvatarURL({ size: 128 }))
          .addFields(
            { name: 'User', value: `<@${member.id}>`, inline: true },
            { name: 'User ID', value: `\`${member.id}\``, inline: true },
            {
              name: 'Account age',
              value: `${accountAgeDays} day(s)`,
              inline: true,
            },
            {
              name: 'Member count',
              value: `${member.guild.memberCount}`,
              inline: true,
            }
          )
          .setFooter({ text: `Guild ID: ${member.guild.id}` })
          .setTimestamp();

        // Flag accounts younger than 7 days — worth a moderator's attention.
        if (accountAgeDays < 7) {
          embed.addFields({
            name: '⚠️ Note',
            value: 'Account is less than 7 days old.',
            inline: false,
          });
        }

        await sendGuildLog(member.guild.id, 'member_join', embed, member.guild);
      } catch (err: any) {
        logger.error('[guildMemberAdd] Join log threw:', err?.message ?? err);
      }
    } catch (err: any) {
      logger.error('[guildMemberAdd] handler threw:', err?.message ?? err);
    }
  },
};

// ===========================================================================
// GUILD MEMBER REMOVE
// Logs leaves. Cannot distinguish kick/ban from organic leave at this event
// level — Discord does not tell us. The mod-action log from the kick/ban
// command is the source of truth for those actions.
// ===========================================================================
export const guildMemberRemoveEvent = {
  name: Events.GuildMemberRemove,
  once: false,
  async execute(member: GuildMember | PartialGuildMember): Promise<void> {
    try {
      if (!member.guild) return;
      if (!member.user) return;
      if (member.user.bot) return;

      const embed = new EmbedBuilder()
        .setTitle('Member Left')
        .setColor(COLOR_LEAVE)
        .setAuthor({
          name: member.user.tag ?? member.user.username,
          iconURL: member.user.displayAvatarURL({ size: 64 }),
        })
        .addFields(
          { name: 'User', value: `<@${member.id}>`, inline: true },
          { name: 'User ID', value: `\`${member.id}\``, inline: true },
          {
            name: 'Joined',
            value: member.joinedTimestamp
              ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>`
              : '*(unknown — member was not cached)*',
            inline: true,
          },
          {
            name: 'Member count',
            value: `${member.guild.memberCount}`,
            inline: true,
          }
        )
        .setFooter({ text: `Guild ID: ${member.guild.id}` })
        .setTimestamp();

      // Best-effort: list roles they had. Partials won't have this info.
      if (member.roles && member.roles.cache.size > 1) {
        const roleList = member.roles.cache
          .filter((r) => r.id !== member.guild.id)
          .map((r) => `<@&${r.id}>`)
          .slice(0, 15)
          .join(', ');
        if (roleList) {
          embed.addFields({ name: 'Roles', value: roleList, inline: false });
        }
      }

      await sendGuildLog(member.guild.id, 'member_leave', embed, member.guild);
    } catch (err: any) {
      logger.error('[guildMemberRemove] handler threw:', err?.message ?? err);
    }
  },
};

// ===========================================================================
// GUILD CREATE
// Fires when the bot is added to a new guild.
//
// Syncs the guild's current Administrator holders into guild_admins so that
// guildAdminOnly commands work immediately for anyone who can configure the
// server. Also sends a friendly "thanks for adding me" DM to the owner.
// ===========================================================================
export const guildCreateEvent = {
  name: Events.GuildCreate,
  once: false,
  async execute(guild: Guild): Promise<void> {
    try {
      logger.info(`[guildCreate] Joined guild ${guild.id} (${guild.name})`);

      // ---- Sync guild admins ---------------------------------------------
      // Requires Server Members intent. If not enabled, fall back to just
      // the guild owner — better than nothing.
      let adminIds: string[] = [];
      try {
        const members = await guild.members.fetch();
        members.forEach((m) => {
          if (m.permissions.has('Administrator') && !m.user.bot) {
            adminIds.push(m.id);
          }
        });
      } catch (err: any) {
        logger.warn(
          `[guildCreate] members.fetch failed for ${guild.id} — falling back to owner only:`,
          err?.message ?? err
        );
        if (guild.ownerId) adminIds.push(guild.ownerId);
      }

      if (adminIds.length === 0 && guild.ownerId) {
        adminIds.push(guild.ownerId);
      }

      await permissionService.syncGuildAdmins(guild.id, adminIds);

      // ---- DM the owner (best effort) -------------------------------------
      try {
        const owner = await guild.fetchOwner();
        const ownerEmbed = new EmbedBuilder()
          .setTitle(`Thanks for adding me to ${guild.name}!`)
          .setColor(COLOR_JOIN_BOT)
          .setDescription(
            [
              'To get started:',
              '',
              '**`*help`** — see all available commands',
              '**`*config`** — view current bot configuration',
              '**`*ticket-setup <category_id> <staff_role_id>`** — set up tickets',
              '**`*welcome-setup #channel <message>`** — set up welcome messages',
              '**`*log-setup #channel`** — set up audit logging',
              '',
              'Need Server Premium? Premium features are permanent and bound to the server.',
            ].join('\n')
          )
          .setFooter({ text: `Guild ID: ${guild.id}` });

        await owner.send({ embeds: [ownerEmbed] }).catch(() => {});
      } catch {
        // DMs may be disabled — not an error.
      }
    } catch (err: any) {
      logger.error('[guildCreate] handler threw:', err?.message ?? err);
    }
  },
};

// ===========================================================================
// GUILD DELETE
// Fires when the bot is removed from a guild (or the guild is deleted).
//
// Cleans up guild_admins rows for this guild. All other data (configs,
// tickets, levels, warnings, giveaways, entitlements) is intentionally
// PRESERVED — if the bot is re-added, the server's data should still be
// there. Only the derived admin cache is cleared, because it will be
// re-synced on rejoin.
// ===========================================================================
export const guildDeleteEvent = {
  name: Events.GuildDelete,
  once: false,
  async execute(guild: Guild): Promise<void> {
    try {
      logger.info(`[guildDelete] Removed from guild ${guild.id} (${guild.name})`);
      await permissionService.clearGuildAdmins(guild.id);
    } catch (err: any) {
      logger.error('[guildDelete] handler threw:', err?.message ?? err);
    }
  },
};
