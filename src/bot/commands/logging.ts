import {
  ChannelType,
  EmbedBuilder,
  Message,
  PermissionFlagsBits,
  TextChannel,
} from 'discord.js';
import { PrefixCommand } from '../commandHandler';
import { supabase } from '../../db/supabase';
import { logger } from '../../utils/logger';

const COLOR = 0x5865f2;

/**
 * Event types that can be logged. Stored as booleans in
 * `guild_configs.automations.log_events` — an existing JSONB column,
 * so no migration is needed to add new event types.
 */
export type LogEventType =
  | 'member_join'
  | 'member_leave'
  | 'message_delete'
  | 'message_edit'
  | 'mod_action'
  | 'ticket';

export const LOG_EVENTS: Record<LogEventType, string> = {
  member_join: 'Member join',
  member_leave: 'Member leave',
  message_delete: 'Message delete',
  message_edit: 'Message edit',
  mod_action: 'Moderation action',
  ticket: 'Ticket open/close',
};

interface LogConfig {
  channelId: string | null;
  enabled: Record<LogEventType, boolean>;
}

const DEFAULT_ENABLED: Record<LogEventType, boolean> = {
  member_join: true,
  member_leave: true,
  message_delete: true,
  message_edit: true,
  mod_action: true,
  ticket: true,
};

function resolveTextChannel(message: Message, raw: string | undefined): TextChannel | null {
  if (!raw || !message.guild) return null;
  const id = raw.replace(/[<#>]/g, '');
  const ch = message.guild.channels.cache.get(id);
  if (!ch || ch.type !== ChannelType.GuildText) return null;
  return ch as TextChannel;
}

async function getLogConfig(guildId: string): Promise<LogConfig> {
  const { data, error } = await supabase
    .from('guild_configs')
    .select('log_channel_id, automations')
    .eq('guild_id', guildId)
    .maybeSingle();

  if (error) {
    logger.error('[logging] config read failed:', error.message);
    return { channelId: null, enabled: { ...DEFAULT_ENABLED } };
  }

  const auto = (data?.automations ?? {}) as Record<string, unknown>;
  const stored = (auto.log_events ?? {}) as Partial<Record<LogEventType, boolean>>;

  return {
    channelId: data?.log_channel_id ?? null,
    enabled: { ...DEFAULT_ENABLED, ...stored },
  };
}

async function writeLogEvents(
  guildId: string,
  updates: Partial<Record<LogEventType, boolean>>
): Promise<void> {
  const { data, error } = await supabase
    .from('guild_configs')
    .select('automations')
    .eq('guild_id', guildId)
    .maybeSingle();

  if (error) {
    logger.error('[logging] writeLogEvents read failed:', error.message);
    throw new Error('Failed to read config.');
  }

  const current = (data?.automations ?? {}) as Record<string, unknown>;
  const currentEvents = (current.log_events ?? {}) as Record<string, boolean>;
  const merged = { ...currentEvents, ...updates };
  const next = { ...current, log_events: merged };

  const { error: upErr } = await supabase
    .from('guild_configs')
    .upsert({ guild_id: guildId, automations: next });

  if (upErr) {
    logger.error('[logging] writeLogEvents upsert failed:', upErr.message);
    throw new Error('Failed to save log event settings.');
  }
}

// ---------------------------------------------------------------------------
// *log-setup <#channel>
// ---------------------------------------------------------------------------
export const logSetupCommand: PrefixCommand = {
  name: 'log-setup',
  description: 'Set the log channel and enable all events',
  guildAdminOnly: true,
  requiredPermissions: PermissionFlagsBits.ManageGuild,
  async execute(message, args) {
    if (!message.guild) return;

    const channel = resolveTextChannel(message, args[0]);
    if (!channel) {
      return message
        .reply('Usage: `*log-setup <#channel>` — the channel where log embeds are posted.')
        .catch(() => {});
    }

    // Verify the bot can actually send embeds there. Failing at setup is
    // much better than silent non-delivery later.
    const me = message.guild.members.me;
    const perms = channel.permissionsFor(me!);
    if (!perms?.has(PermissionFlagsBits.SendMessages) || !perms.has(PermissionFlagsBits.EmbedLinks)) {
      return message
        .reply(
          `❌ I need **Send Messages** and **Embed Links** in <#${channel.id}> to log there.`
        )
        .catch(() => {});
    }

    const { error } = await supabase.from('guild_configs').upsert({
      guild_id: message.guild.id,
      log_channel_id: channel.id,
    });

    if (error) {
      logger.error('[log-setup] upsert failed:', error.message);
      return message.reply('❌ Failed to save log channel.').catch(() => {});
    }

    await message
      .reply(
        `✅ Log channel set to <#${channel.id}>.\n` +
          `All event types are enabled by default. Use \`*log-toggle <event>\` to change.`
      )
      .catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// *log-disable  — remove the log channel
// ---------------------------------------------------------------------------
export const logDisableCommand: PrefixCommand = {
  name: 'log-disable',
  description: 'Disable logging for this server',
  guildAdminOnly: true,
  requiredPermissions: PermissionFlagsBits.ManageGuild,
  async execute(message) {
    if (!message.guild) return;

    const { error } = await supabase
      .from('guild_configs')
      .update({ log_channel_id: null })
      .eq('guild_id', message.guild.id);

    if (error) {
      logger.error('[log-disable] update failed:', error.message);
      return message.reply('❌ Failed to disable logging.').catch(() => {});
    }

    await message.reply('✅ Logging disabled. Event toggles are preserved.').catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// *log-toggle <event>
// Flip an event type on/off.
// ---------------------------------------------------------------------------
export const logToggleCommand: PrefixCommand = {
  name: 'log-toggle',
  description: 'Toggle a specific log event type',
  guildAdminOnly: true,
  requiredPermissions: PermissionFlagsBits.ManageGuild,
  async execute(message, args) {
    if (!message.guild) return;

    const key = args[0]?.toLowerCase() as LogEventType | undefined;

    if (!key || !(key in LOG_EVENTS)) {
      const list = Object.entries(LOG_EVENTS)
        .map(([k, v]) => `\`${k}\` — ${v}`)
        .join('\n');
      return message
        .reply(`Usage: \`*log-toggle <event>\`\n\nAvailable events:\n${list}`)
        .catch(() => {});
    }

    const cfg = await getLogConfig(message.guild.id);
    const next = !cfg.enabled[key];

    try {
      await writeLogEvents(message.guild.id, { [key]: next });
    } catch (err: any) {
      return message.reply(`❌ ${err.message}`).catch(() => {});
    }

    await message
      .reply(`✅ **${LOG_EVENTS[key]}** logging ${next ? 'enabled' : 'disabled'}.`)
      .catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// *log-config  — view current state
// ---------------------------------------------------------------------------
export const logConfigCommand: PrefixCommand = {
  name: 'log-config',
  description: 'View the current logging configuration',
  guildAdminOnly: true,
  async execute(message) {
    if (!message.guild) return;

    const cfg = await getLogConfig(message.guild.id);

    const embed = new EmbedBuilder()
      .setTitle('Logging Configuration')
      .setColor(cfg.channelId ? COLOR : 0x99aab5)
      .addFields(
        {
          name: 'Status',
          value: cfg.channelId ? `✅ Enabled → <#${cfg.channelId}>` : '❌ Disabled',
          inline: false,
        },
        {
          name: 'Event types',
          value: (Object.keys(LOG_EVENTS) as LogEventType[])
            .map((k) => {
              const on = cfg.enabled[k];
              return `${on ? '🟢' : '🔴'} \`${k}\` — ${LOG_EVENTS[k]}`;
            })
            .join('\n'),
          inline: false,
        }
      )
      .setFooter({ text: 'Toggle: *log-toggle <event>' });

    await message.reply({ embeds: [embed] }).catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// Exported helper used by events (guildMemberAdd/Remove, messageDelete/Edit,
// moderation commands, ticket service) to actually send a log embed.
//
// Kept in this module rather than a separate service because the config
// reads and the write path are tightly coupled — one file, one concern.
// ---------------------------------------------------------------------------
export async function sendGuildLog(
  guildId: string,
  eventType: LogEventType,
  embed: EmbedBuilder,
  guild: import('discord.js').Guild
): Promise<void> {
  const cfg = await getLogConfig(guildId);
  if (!cfg.channelId || !cfg.enabled[eventType]) return;

  const channel = await guild.channels.fetch(cfg.channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  await (channel as TextChannel).send({ embeds: [embed] }).catch((err) => {
    logger.warn(`[logging] Failed to send ${eventType} log:`, err?.message ?? err);
  });
}

// ---------------------------------------------------------------------------
// Bulk export
// ---------------------------------------------------------------------------
export const loggingCommands: PrefixCommand[] = [
  logSetupCommand,
  logDisableCommand,
  logToggleCommand,
  logConfigCommand,
];
