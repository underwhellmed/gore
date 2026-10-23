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

const COLOR = 0x57f287;

/**
 * Placeholders supported in welcome messages:
 *   {user}      — mentions the new member
 *   {username}  — their username (no mention)
 *   {server}    — the guild name
 *   {count}     — current member count
 *
 * Rendered in guildMemberAdd.ts using the same helper to keep formatting
 * consistent — the *welcome-test command uses it too so admins can preview
 * exactly what a real join will look like.
 */
export function renderWelcome(template: string, member: { id: string; user: { username: string }; guild: { name: string; memberCount: number } }): string {
  return template
    .replace(/\{user\}/g, `<@${member.id}>`)
    .replace(/\{username\}/g, member.user.username)
    .replace(/\{server\}/g, member.guild.name)
    .replace(/\{count\}/g, String(member.guild.memberCount));
}

function resolveTextChannel(message: Message, raw: string | undefined): TextChannel | null {
  if (!raw || !message.guild) return null;
  const id = raw.replace(/[<#>]/g, '');
  const ch = message.guild.channels.cache.get(id);
  if (!ch || ch.type !== ChannelType.GuildText) return null;
  return ch as TextChannel;
}

async function getWelcomeConfig(guildId: string) {
  const { data, error } = await supabase
    .from('guild_configs')
    .select('welcome_channel_id, welcome_message')
    .eq('guild_id', guildId)
    .maybeSingle();
  if (error) {
    logger.error('[welcome] config read failed:', error.message);
    return null;
  }
  return data;
}

// ---------------------------------------------------------------------------
// *welcome-setup <#channel> <message>
// ---------------------------------------------------------------------------
export const welcomeSetupCommand: PrefixCommand = {
  name: 'welcome-setup',
  description: 'Configure welcome channel and message',
  guildAdminOnly: true,
  requiredPermissions: PermissionFlagsBits.ManageGuild,
  async execute(message, args) {
    if (!message.guild) return;

    const channel = resolveTextChannel(message, args[0]);
    if (!channel) {
      return message
        .reply(
          'Usage: `*welcome-setup <#channel> <message>`\n' +
            'Placeholders: `{user}`, `{username}`, `{server}`, `{count}`'
        )
        .catch(() => {});
    }

    // Everything after the channel argument is the template.
    const template = args.slice(1).join(' ').trim();
    if (!template) {
      return message
        .reply(
          '❌ Provide a message. Example:\n' +
            '`*welcome-setup #general Welcome {user} to {server}! You are member #{count}.`'
        )
        .catch(() => {});
    }

    if (template.length > 1000) {
      return message.reply('❌ Welcome message must be 1000 characters or fewer.').catch(() => {});
    }

    const { error } = await supabase.from('guild_configs').upsert({
      guild_id: message.guild.id,
      welcome_channel_id: channel.id,
      welcome_message: template,
    });

    if (error) {
      logger.error('[welcome-setup] upsert failed:', error.message);
      return message.reply('❌ Failed to save welcome configuration.').catch(() => {});
    }

    await message
      .reply(`✅ Welcome configured.\nChannel: <#${channel.id}>\nMessage: ${template}`)
      .catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// *welcome-message <message>  — update the message only
// Useful when the channel is fine but the wording changed.
// ---------------------------------------------------------------------------
export const welcomeMessageCommand: PrefixCommand = {
  name: 'welcome-message',
  description: 'Update the welcome message without changing the channel',
  guildAdminOnly: true,
  requiredPermissions: PermissionFlagsBits.ManageGuild,
  async execute(message, args) {
    if (!message.guild) return;

    const template = args.join(' ').trim();
    if (!template) {
      return message
        .reply('Usage: `*welcome-message <message>` — supports `{user}` etc.')
        .catch(() => {});
    }
    if (template.length > 1000) {
      return message.reply('❌ Message must be 1000 characters or fewer.').catch(() => {});
    }

    const existing = await getWelcomeConfig(message.guild.id);
    if (!existing?.welcome_channel_id) {
      return message
        .reply('❌ Set a welcome channel first with `*welcome-setup`.')
        .catch(() => {});
    }

    const { error } = await supabase
      .from('guild_configs')
      .update({ welcome_message: template })
      .eq('guild_id', message.guild.id);

    if (error) {
      logger.error('[welcome-message] update failed:', error.message);
      return message.reply('❌ Failed to update welcome message.').catch(() => {});
    }

    await message.reply(`✅ Welcome message updated:\n${template}`).catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// *welcome-test  — send a preview of the welcome in the configured channel
// Uses the caller as the fake "new member". Very useful for validating
// formatting before any real joins happen.
// ---------------------------------------------------------------------------
export const welcomeTestCommand: PrefixCommand = {
  name: 'welcome-test',
  description: 'Send a preview of the welcome message',
  guildAdminOnly: true,
  requiredPermissions: PermissionFlagsBits.ManageGuild,
  async execute(message) {
    if (!message.guild || !message.member) return;

    const cfg = await getWelcomeConfig(message.guild.id);
    if (!cfg?.welcome_channel_id || !cfg?.welcome_message) {
      return message
        .reply('❌ Welcome is not configured. Use `*welcome-setup` first.')
        .catch(() => {});
    }

    const channel = await message.guild.channels
      .fetch(cfg.welcome_channel_id)
      .catch(() => null);

    if (!channel || !channel.isTextBased()) {
      return message.reply('❌ Configured welcome channel no longer exists.').catch(() => {});
    }

    const rendered = renderWelcome(cfg.welcome_message, message.member);
    await (channel as TextChannel).send(`**[TEST]** ${rendered}`);

    await message.reply(`✅ Preview sent to <#${channel.id}>.`).catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// *welcome-disable  — turn welcome off
// ---------------------------------------------------------------------------
export const welcomeDisableCommand: PrefixCommand = {
  name: 'welcome-disable',
  description: 'Disable welcome messages for this server',
  guildAdminOnly: true,
  requiredPermissions: PermissionFlagsBits.ManageGuild,
  async execute(message) {
    if (!message.guild) return;

    const { error } = await supabase
      .from('guild_configs')
      .update({ welcome_channel_id: null, welcome_message: null })
      .eq('guild_id', message.guild.id);

    if (error) {
      logger.error('[welcome-disable] update failed:', error.message);
      return message.reply('❌ Failed to disable welcome.').catch(() => {});
    }

    await message.reply('✅ Welcome messages disabled.').catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// *welcome-config  — view current welcome configuration
// ---------------------------------------------------------------------------
export const welcomeConfigCommand: PrefixCommand = {
  name: 'welcome-config',
  description: 'View the current welcome configuration',
  guildAdminOnly: true,
  async execute(message) {
    if (!message.guild) return;

    const cfg = await getWelcomeConfig(message.guild.id);

    const embed = new EmbedBuilder()
      .setTitle('Welcome Configuration')
      .setColor(cfg?.welcome_channel_id ? COLOR : 0x99aab5)
      .addFields(
        {
          name: 'Status',
          value: cfg?.welcome_channel_id ? '✅ Enabled' : '❌ Disabled',
          inline: true,
        },
        {
          name: 'Channel',
          value: cfg?.welcome_channel_id ? `<#${cfg.welcome_channel_id}>` : '—',
          inline: true,
        },
        {
          name: 'Message',
          value: cfg?.welcome_message ?? '—',
          inline: false,
        }
      )
      .setFooter({
        text: 'Placeholders: {user}, {username}, {server}, {count}',
      });

    await message.reply({ embeds: [embed] }).catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// Bulk export
// ---------------------------------------------------------------------------
export const welcomeCommands: PrefixCommand[] = [
  welcomeSetupCommand,
  welcomeMessageCommand,
  welcomeTestCommand,
  welcomeDisableCommand,
  welcomeConfigCommand,
];
