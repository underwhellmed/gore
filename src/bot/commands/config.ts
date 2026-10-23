import { EmbedBuilder, Message } from 'discord.js';
import { PrefixCommand } from '../commandHandler';
import { supabase } from '../../db/supabase';
import { entitlementService } from '../../services/entitlementService';
import { logger } from '../../utils/logger';

const COLOR = 0x5865f2;

interface GuildConfigRow {
  guild_id: string;
  ticket_category_id: string | null;
  ticket_log_channel_id: string | null;
  ticket_staff_role_id: string | null;
  welcome_channel_id: string | null;
  welcome_message: string | null;
  log_channel_id: string | null;
  leveling_enabled: boolean;
  giveaways_enabled: boolean;
  automations: Record<string, unknown> | null;
  premium_customization: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

async function fetchConfig(guildId: string): Promise<GuildConfigRow | null> {
  const { data, error } = await supabase
    .from('guild_configs')
    .select('*')
    .eq('guild_id', guildId)
    .maybeSingle();

  if (error) {
    logger.error('[config] read failed:', error.message);
    return null;
  }
  return (data as GuildConfigRow | null) ?? null;
}

function or(value: string | null | undefined, fallback = '—'): string {
  return value && value.trim() !== '' ? value : fallback;
}

function fmtChannel(id: string | null | undefined): string {
  return id ? `<#${id}>` : '—';
}

function fmtRole(id: string | null | undefined): string {
  return id ? `<@&${id}>` : '—';
}

function fmtBool(v: boolean | null | undefined): string {
  return v ? '✅ Enabled' : '❌ Disabled';
}

// ---------------------------------------------------------------------------
// *config  —  one-page overview of everything configured for this server
// ---------------------------------------------------------------------------
export const configCommand: PrefixCommand = {
  name: 'config',
  description: 'View all bot configuration for this server',
  guildAdminOnly: true,
  async execute(message) {
    if (!message.guild) return;

    const cfg = await fetchConfig(message.guild.id);
    const hasPremium = await entitlementService.hasServerPremium(message.guild.id);

    if (!cfg) {
      const embed = new EmbedBuilder()
        .setTitle('Server Configuration')
        .setColor(0x99aab5)
        .setDescription(
          'No configuration found for this server yet.\n' +
            'Use `*ticket-setup`, `*welcome-setup`, `*log-setup`, or `*level-toggle` to get started.'
        )
        .setFooter({ text: `Guild ID: ${message.guild.id}` });
      return message.reply({ embeds: [embed] }).catch(() => {});
    }

    const auto = cfg.automations ?? {};
    const levelUpChannelId =
      typeof auto.level_up_channel_id === 'string' ? auto.level_up_channel_id : null;
    const xpMultiplier =
      typeof auto.xp_multiplier === 'number' ? auto.xp_multiplier : 1;
    const logEvents = (auto.log_events ?? {}) as Record<string, boolean>;
    const enabledLogCount = Object.values(logEvents).filter((v) => v === true).length;

    const embed = new EmbedBuilder()
      .setTitle(`Server Configuration — ${message.guild.name}`)
      .setColor(hasPremium ? 0x57f287 : COLOR)
      .setThumbnail(message.guild.iconURL({ size: 128 }))
      .addFields(
        {
          name: '🎫 Tickets',
          value: [
            `Category: ${fmtChannel(cfg.ticket_category_id)}`,
            `Staff role: ${fmtRole(cfg.ticket_staff_role_id)}`,
            `Log channel: ${fmtChannel(cfg.ticket_log_channel_id)}`,
          ].join('\n'),
          inline: false,
        },
        {
          name: '👋 Welcome',
          value: [
            `Status: ${cfg.welcome_channel_id ? '✅ Enabled' : '❌ Disabled'}`,
            `Channel: ${fmtChannel(cfg.welcome_channel_id)}`,
            `Message: ${
              cfg.welcome_message
                ? cfg.welcome_message.length > 100
                  ? `\`${cfg.welcome_message.slice(0, 100)}…\``
                  : `\`${cfg.welcome_message}\``
                : '—'
            }`,
          ].join('\n'),
          inline: false,
        },
        {
          name: '📝 Logging',
          value: [
            `Status: ${cfg.log_channel_id ? `✅ Enabled → ${fmtChannel(cfg.log_channel_id)}` : '❌ Disabled'}`,
            `Events enabled: ${enabledLogCount} / 6`,
          ].join('\n'),
          inline: false,
        },
        {
          name: '📈 Leveling',
          value: [
            `Status: ${fmtBool(cfg.leveling_enabled)}`,
            `Level-up channel: ${fmtChannel(levelUpChannelId)}`,
            `XP multiplier: ${xpMultiplier}x${xpMultiplier > 1 ? ' ⭐' : ''}`,
          ].join('\n'),
          inline: false,
        },
        {
          name: '🎉 Giveaways',
          value: fmtBool(cfg.giveaways_enabled),
          inline: true,
        },
        {
          name: '⭐ Premium',
          value: hasPremium ? '✅ Server Premium active' : '❌ No Server Premium',
          inline: true,
        }
      )
      .setFooter({
        text: `Guild ID: ${message.guild.id} · Updated ${new Date(cfg.updated_at).toISOString().slice(0, 10)}`,
      });

    await message.reply({ embeds: [embed] }).catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// *config-export  —  dump the raw JSON config (for debugging / migration)
// ---------------------------------------------------------------------------
export const configExportCommand: PrefixCommand = {
  name: 'config-export',
  description: 'Export this server configuration as JSON',
  guildAdminOnly: true,
  async execute(message) {
    if (!message.guild) return;

    const cfg = await fetchConfig(message.guild.id);
    if (!cfg) {
      return message.reply('❌ No configuration found.').catch(() => {});
    }

    const json = JSON.stringify(cfg, null, 2);
    const buffer = Buffer.from(json, 'utf-8');

    await message
      .reply({
        content: '📎 Server configuration export',
        files: [{ attachment: buffer, name: `config-${message.guild.id}.json` }],
      })
      .catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// *config-reset  —  delete all bot configuration for this server
// Requires typed confirmation to prevent accidents.
// ---------------------------------------------------------------------------
export const configResetCommand: PrefixCommand = {
  name: 'config-reset',
  description: 'Delete ALL bot configuration for this server (dangerous)',
  guildAdminOnly: true,
  async execute(message, args) {
    if (!message.guild) return;

    if (args[0]?.toLowerCase() !== 'confirm') {
      return message
        .reply(
          '⚠️ **DANGER** — this deletes all bot configuration for this server:\n' +
            '• Ticket settings\n' +
            '• Welcome settings\n' +
            '• Log channel and event toggles\n' +
            '• Leveling configuration (levels table is NOT affected)\n' +
            '• Giveaway kill-switch flag\n\n' +
            'Premium entitlements are **not** deleted.\n\n' +
            'Type `*config-reset confirm` to proceed.'
        )
        .catch(() => {});
    }

    const { error } = await supabase
      .from('guild_configs')
      .delete()
      .eq('guild_id', message.guild.id);

    if (error) {
      logger.error('[config-reset] delete failed:', error.message);
      return message.reply('❌ Failed to reset configuration.').catch(() => {});
    }

    await message
      .reply(
        '✅ All bot configuration for this server has been deleted.\n' +
          'Existing level records and active giveaways are unaffected.'
      )
      .catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// *sync-guild-admins  —  refresh the guild_admins table from Discord
// Only needed when a new admin is added mid-session and you don't want to
// wait for the next bot restart. Cheap enough to run on demand.
// ---------------------------------------------------------------------------
export const syncGuildAdminsCommand: PrefixCommand = {
  name: 'sync-guild-admins',
  description: 'Refresh the admin list for this server from Discord',
  adminOnly: true,
  async execute(message) {
    if (!message.guild) return;

    // Fetch all members with Administrator. The bot needs to be able to
    // fetch members — requires Server Members privileged intent (enabled
    // in the Discord Developer Portal).
    const admins: string[] = [];
    try {
      const members = await message.guild.members.fetch();
      members.forEach((m) => {
        if (m.permissions.has('Administrator') && !m.user.bot) {
          admins.push(m.id);
        }
      });
    } catch (err: any) {
      logger.error('[sync-guild-admins] member fetch failed:', err?.message ?? err);
      return message
        .reply(
          '❌ Failed to fetch guild members. Ensure the bot has the **Server Members** intent enabled.'
        )
        .catch(() => {});
    }

    // Delegate to permissionService for the actual DB write.
    const { permissionService } = await import('../../services/permissionService');
    await permissionService.syncGuildAdmins(message.guild.id, admins);

    await message
      .reply(
        `✅ Synced **${admins.length}** guild admin(s) for this server.`
      )
      .catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// Bulk export
// ---------------------------------------------------------------------------
export const configCommands: PrefixCommand[] = [
  configCommand,
  configExportCommand,
  configResetCommand,
  syncGuildAdminsCommand,
];
