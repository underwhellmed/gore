import {
  CategoryChannel,
  ChannelType,
  EmbedBuilder,
  GuildBasedChannel,
  Message,
  PermissionFlagsBits,
  Role,
  TextChannel,
} from 'discord.js';
import { PrefixCommand } from '../commandHandler';
import { ticketService } from '../../services/ticketService';
import { supabase } from '../../db/supabase';
import { logger } from '../../utils/logger';

const COLOR = 0x5865f2;

// ---------------------------------------------------------------------------
// Argument resolution helpers — accept either a mention or a raw snowflake.
// ---------------------------------------------------------------------------
function resolveChannel(
  message: Message,
  raw: string | undefined
): GuildBasedChannel | null {
  if (!raw || !message.guild) return null;
  const id = raw.replace(/[<#>]/g, '');
  return message.guild.channels.cache.get(id) ?? null;
}

function resolveRole(message: Message, raw: string | undefined): Role | null {
  if (!raw || !message.guild) return null;
  const id = raw.replace(/[<@&>]/g, '');
  return message.guild.roles.cache.get(id) ?? null;
}

function isStaff(message: Message): boolean {
  return !!message.member?.permissions.has(PermissionFlagsBits.ManageChannels);
}

async function getTicketConfig(guildId: string) {
  const { data, error } = await supabase
    .from('guild_configs')
    .select('ticket_category_id, ticket_staff_role_id, ticket_log_channel_id')
    .eq('guild_id', guildId)
    .maybeSingle();
  if (error) {
    logger.error('[ticket] config read failed:', error.message);
    return null;
  }
  return data;
}

// ---------------------------------------------------------------------------
// *ticket-setup <category_id> <staff_role_id> [#panel_channel]
// Configures the ticket category + staff role, then posts the panel.
// ---------------------------------------------------------------------------
export const ticketSetupCommand: PrefixCommand = {
  name: 'ticket-setup',
  description: 'Configure ticket category, staff role, and post the panel',
  guildAdminOnly: true,
  requiredPermissions: PermissionFlagsBits.ManageGuild,
  async execute(message, args) {
    if (!message.guild) return;

    const categoryRaw = args[0];
    const staffRoleRaw = args[1];
    const panelChannelRaw = args[2];

    const category = resolveChannel(message, categoryRaw);
    const staffRole = resolveRole(message, staffRoleRaw);

    if (!category || category.type !== ChannelType.GuildCategory) {
      return message
        .reply('Usage: `*ticket-setup <category_id> <staff_role_id> [#panel_channel]`')
        .catch(() => {});
    }
    if (!staffRole) {
      return message
        .reply('❌ Staff role not found. Provide a role ID or mention.')
        .catch(() => {});
    }

    const panelChannel = panelChannelRaw
      ? resolveChannel(message, panelChannelRaw)
      : message.channel;

    if (!panelChannel || !panelChannel.isTextBased()) {
      return message
        .reply('❌ Panel channel not found or not a text channel.')
        .catch(() => {});
    }

    const { error } = await supabase.from('guild_configs').upsert({
      guild_id: message.guild.id,
      ticket_category_id: category.id,
      ticket_staff_role_id: staffRole.id,
    });

    if (error) {
      logger.error('[ticket-setup] upsert failed:', error.message);
      return message.reply('❌ Failed to save ticket configuration.').catch(() => {});
    }

    await postPanel(message.guild.id, panelChannel as TextChannel);

    await message
      .reply(
        `✅ Ticket system configured.\n` +
          `Category: <#${category.id}>\n` +
          `Staff role: <@&${staffRole.id}>\n` +
          `Panel posted in <#${panelChannel.id}>.`
      )
      .catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// *ticket-panel [#channel]  — re-post the panel using existing config
// ---------------------------------------------------------------------------
export const ticketPanelCommand: PrefixCommand = {
  name: 'ticket-panel',
  description: 'Post the ticket panel in a channel',
  guildAdminOnly: true,
  requiredPermissions: PermissionFlagsBits.ManageGuild,
  async execute(message, args) {
    if (!message.guild) return;

    const cfg = await getTicketConfig(message.guild.id);
    if (!cfg?.ticket_category_id || !cfg?.ticket_staff_role_id) {
      return message
        .reply('❌ Ticket system is not configured. Run `*ticket-setup` first.')
        .catch(() => {});
    }

    const target = args[0] ? resolveChannel(message, args[0]) : message.channel;
    if (!target || !target.isTextBased()) {
      return message.reply('❌ Panel channel not found.').catch(() => {});
    }

    await postPanel(message.guild.id, target as TextChannel);
    await message.reply(`✅ Panel posted in <#${target.id}>.`).catch(() => {});
  },
};

async function postPanel(guildId: string, channel: TextChannel): Promise<void> {
  // Check for per-guild premium customization — panel respects embed color
  // and footer if the guild has Server Premium.
  const { data: cust } = await supabase
    .from('premium_customizations')
    .select('custom_embeds')
    .eq('guild_id', guildId)
    .maybeSingle();

  const embeds = (cust?.custom_embeds ?? {}) as { color?: string; footer?: string; thumbnail?: string };
  const color = embeds.color ? parseInt(embeds.color.replace('#', ''), 16) : COLOR;

  const embed = new EmbedBuilder()
    .setTitle('Support Tickets')
    .setDescription(
      'Click the button below to open a private ticket with our staff.\n' +
        'Only you and the staff team can see your ticket.'
    )
    .setColor(color);

  if (embeds.footer) embed.setFooter({ text: embeds.footer });
  if (embeds.thumbnail) embed.setThumbnail(embeds.thumbnail);

  const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import('discord.js');
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_create')
      .setLabel('Open Ticket')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('🎫')
  );

  await channel.send({ embeds: [embed], components: [row] });
}

// ---------------------------------------------------------------------------
// *ticket-close [reason]
// Owner or staff can close the current ticket.
// ---------------------------------------------------------------------------
export const ticketCloseCommand: PrefixCommand = {
  name: 'ticket-close',
  description: 'Close the current ticket',
  async execute(message, args) {
    if (!message.guild || !message.channel.isTextBased()) return;

    const ticket = await ticketService.getOpenTicketByChannel(message.channel.id);
    if (!ticket) {
      return message.reply('❌ This channel is not an open ticket.').catch(() => {});
    }

    const isOwner = ticket.owner_id === message.author.id;
    const isStaffMember = isStaff(message);

    if (!isOwner && !isStaffMember) {
      return message
        .reply('❌ Only the ticket owner or staff can close this ticket.')
        .catch(() => {});
    }

    const cfg = await getTicketConfig(message.guild.id);
    const reason = args.join(' ').trim() || undefined;

    await message
      .reply(
        `🔒 Closing ticket${reason ? ` (${reason})` : ''}... Generating transcript.`
      )
      .catch(() => {});

    try {
      await ticketService.closeTicket(
        message.channel as TextChannel,
        message.member!,
        cfg?.ticket_log_channel_id ?? undefined
      );
    } catch (err: any) {
      logger.error('[ticket-close] failed:', err?.message ?? err);
      await message
        .reply(`❌ ${err.message ?? 'Failed to close ticket.'}`)
        .catch(() => {});
    }
  },
};

// ---------------------------------------------------------------------------
// *ticket-claim  — staff claim
// ---------------------------------------------------------------------------
export const ticketClaimCommand: PrefixCommand = {
  name: 'ticket-claim',
  description: 'Claim the current ticket',
  requiredPermissions: PermissionFlagsBits.ManageChannels,
  async execute(message) {
    if (!message.guild || !message.channel.isTextBased()) return;

    const ticket = await ticketService.getOpenTicketByChannel(message.channel.id);
    if (!ticket) {
      return message.reply('❌ This channel is not an open ticket.').catch(() => {});
    }

    const claimed = await ticketService.claimTicket(message.channel.id, message.member!);
    if (!claimed) {
      const claimant = ticket.claimed_by ? `<@${ticket.claimed_by}>` : 'someone else';
      return message.reply(`⚠️ Ticket already claimed by ${claimant}.`).catch(() => {});
    }

    await message.reply(`✅ Ticket claimed by <@${message.author.id}>.`).catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// *ticket-add @user  — add a user to the current ticket
// ---------------------------------------------------------------------------
export const ticketAddCommand: PrefixCommand = {
  name: 'ticket-add',
  description: 'Add a user to the current ticket',
  requiredPermissions: PermissionFlagsBits.ManageChannels,
  async execute(message) {
    if (!message.guild || !message.channel.isTextBased()) return;

    const ticket = await ticketService.getOpenTicketByChannel(message.channel.id);
    if (!ticket) {
      return message.reply('❌ This channel is not an open ticket.').catch(() => {});
    }

    const target = message.mentions.members?.first();
    if (!target) {
      return message.reply('Usage: `*ticket-add @user`').catch(() => {});
    }

    await (message.channel as TextChannel).permissionOverwrites.edit(target.id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      AttachFiles: true,
    });

    await message.reply(`✅ Added <@${target.id}> to the ticket.`).catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// *ticket-remove @user
// ---------------------------------------------------------------------------
export const ticketRemoveCommand: PrefixCommand = {
  name: 'ticket-remove',
  description: 'Remove a user from the current ticket',
  requiredPermissions: PermissionFlagsBits.ManageChannels,
  async execute(message) {
    if (!message.guild || !message.channel.isTextBased()) return;

    const ticket = await ticketService.getOpenTicketByChannel(message.channel.id);
    if (!ticket) {
      return message.reply('❌ This channel is not an open ticket.').catch(() => {});
    }

    const target = message.mentions.members?.first();
    if (!target) {
      return message.reply('Usage: `*ticket-remove @user`').catch(() => {});
    }

    if (target.id === ticket.owner_id) {
      return message
        .reply('❌ Cannot remove the ticket owner. Close the ticket instead.')
        .catch(() => {});
    }

    if (target.id === message.client.user?.id) {
      return message.reply('❌ Cannot remove the bot from its own ticket.').catch(() => {});
    }

    await (message.channel as TextChannel).permissionOverwrites.delete(target.id);
    await message.reply(`✅ Removed <@${target.id}> from the ticket.`).catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// *ticket-transcript  — get a signed transcript link
// Available to staff and (after close) to the original owner.
// ---------------------------------------------------------------------------
export const ticketTranscriptCommand: PrefixCommand = {
  name: 'ticket-transcript',
  description: 'Get a transcript link for the current ticket',
  async execute(message) {
    if (!message.guild || !message.channel.isTextBased()) return;

    const { data: ticket, error } = await supabase
      .from('tickets')
      .select('ticket_id, owner_id, status, transcript_url')
      .eq('channel_id', message.channel.id)
      .maybeSingle();

    if (error || !ticket) {
      return message
        .reply('❌ This channel is not associated with a ticket.')
        .catch(() => {});
    }

    const isOwner = ticket.owner_id === message.author.id;
    const isStaffMember = isStaff(message);
    if (!isOwner && !isStaffMember) {
      return message
        .reply('❌ Only the ticket owner or staff can access transcripts.')
        .catch(() => {});
    }

    if (!ticket.transcript_url) {
      return message
        .reply(
          '⚠️ No transcript exists yet. It will be generated when the ticket is closed.'
        )
        .catch(() => {});
    }

    const url = await ticketService.getTranscriptSignedUrl(ticket.transcript_url, 3600);
    if (!url) {
      return message.reply('❌ Failed to generate a transcript link.').catch(() => {});
    }

    await message
      .reply(`📄 Transcript (expires in 1 hour): ${url}`)
      .catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// *ticket-config  — view current ticket configuration
// ---------------------------------------------------------------------------
export const ticketConfigCommand: PrefixCommand = {
  name: 'ticket-config',
  description: 'View the current ticket configuration',
  guildAdminOnly: true,
  async execute(message) {
    if (!message.guild) return;

    const cfg = await getTicketConfig(message.guild.id);
    if (!cfg) {
      return message.reply('❌ No ticket configuration found.').catch(() => {});
    }

    const embed = new EmbedBuilder()
      .setTitle('Ticket Configuration')
      .setColor(COLOR)
      .addFields(
        {
          name: 'Category',
          value: cfg.ticket_category_id ? `<#${cfg.ticket_category_id}>` : '— (not set)',
          inline: true,
        },
        {
          name: 'Staff role',
          value: cfg.ticket_staff_role_id ? `<@&${cfg.ticket_staff_role_id}>` : '— (not set)',
          inline: true,
        },
        {
          name: 'Log channel',
          value: cfg.ticket_log_channel_id ? `<#${cfg.ticket_log_channel_id}>` : '— (not set)',
          inline: false,
        }
      )
      .setFooter({
        text: 'Setup: *ticket-setup <category> <staff_role> [#panel_channel]',
      });

    await message.reply({ embeds: [embed] }).catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// Bulk export
// ---------------------------------------------------------------------------
export const ticketCommands: PrefixCommand[] = [
  ticketSetupCommand,
  ticketPanelCommand,
  ticketCloseCommand,
  ticketClaimCommand,
  ticketAddCommand,
  ticketRemoveCommand,
  ticketTranscriptCommand,
  ticketConfigCommand,
];
