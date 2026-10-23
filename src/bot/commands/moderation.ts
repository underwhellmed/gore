import {
  EmbedBuilder,
  GuildMember,
  Message,
  PermissionFlagsBits,
  TextChannel,
} from 'discord.js';
import { PrefixCommand } from '../commandHandler';
import { supabase } from '../../db/supabase';
import { logger } from '../../utils/logger';
import { sendGuildLog } from './logging';

const COLOR_WARN = 0xfee75c;
const COLOR_KICK = 0xff9f1c;
const COLOR_BAN = 0xed4245;
const COLOR_INFO = 0x5865f2;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Return an error string if `moderator` cannot act on `target`, else null.
 * Discord hierarchy rules:
 *   - Moderator's highest role must be above the target's highest role
 *     (except if the moderator is the guild owner).
 *   - The bot's highest role must also be above the target's, or Discord
 *     will reject the action.
 *   - You cannot act on yourself.
 *   - You cannot act on the guild owner (ever).
 */
function checkHierarchy(
  moderator: GuildMember,
  target: GuildMember,
  action: string
): string | null {
  if (moderator.id === target.id) {
    return `❌ You cannot ${action} yourself.`;
  }
  if (target.id === target.guild.ownerId) {
    return `❌ You cannot ${action} the server owner.`;
  }
  if (moderator.id !== moderator.guild.ownerId) {
    if (moderator.roles.highest.position <= target.roles.highest.position) {
      return `❌ You cannot ${action} a member with an equal or higher role.`;
    }
  }
  const me = target.guild.members.me;
  if (me && me.roles.highest.position <= target.roles.highest.position) {
    return `❌ I cannot ${action} this member — their role is above mine.`;
  }
  return null;
}

function parseUserTarget(message: Message): GuildMember | null {
  return message.mentions.members?.first() ?? null;
}

async function logModAction(
  guild: import('discord.js').Guild,
  embed: EmbedBuilder
): Promise<void> {
  await sendGuildLog(guild.id, 'mod_action', embed, guild);
}

// ---------------------------------------------------------------------------
// *warn @user [reason]
// ---------------------------------------------------------------------------
export const warnCommand: PrefixCommand = {
  name: 'warn',
  description: 'Warn a member and record the warning',
  requiredPermissions: PermissionFlagsBits.ModerateMembers,
  async execute(message, args) {
    if (!message.guild || !message.member) return;

    const target = parseUserTarget(message);
    if (!target) {
      return message.reply('Usage: `*warn @user [reason]`').catch(() => {});
    }

    const hierarchyError = checkHierarchy(message.member, target, 'warn');
    if (hierarchyError) return message.reply(hierarchyError).catch(() => {});

    const reason = args.slice(1).join(' ').trim() || 'No reason provided';

    const { data, error } = await supabase
      .from('warnings')
      .insert({
        guild_id: message.guild.id,
        user_id: target.id,
        moderator_id: message.author.id,
        reason,
      })
      .select('id, created_at')
      .single();

    if (error || !data) {
      logger.error('[warn] insert failed:', error?.message);
      return message.reply('❌ Failed to record warning.').catch(() => {});
    }

    // DM the target — best effort, never fails the command.
    await target
      .send({
        embeds: [
          new EmbedBuilder()
            .setTitle(`You were warned in ${message.guild.name}`)
            .setDescription(reason)
            .setColor(COLOR_WARN)
            .setFooter({ text: `Warning ID: ${data.id}` })
            .setTimestamp(),
        ],
      })
      .catch(() => {});

    // Count total warnings for context.
    const { count } = await supabase
      .from('warnings')
      .select('id', { count: 'exact', head: true })
      .eq('guild_id', message.guild.id)
      .eq('user_id', target.id);

    await message
      .reply(
        `✅ Warned <@${target.id}> — ${reason}\n` +
          `-# Warning ID: \`${data.id}\` • Total warnings: ${count ?? 1}`
      )
      .catch(() => {});

    await logModAction(
      message.guild,
      new EmbedBuilder()
        .setTitle('Member Warned')
        .setColor(COLOR_WARN)
        .addFields(
          { name: 'Member', value: `<@${target.id}> \`${target.id}\``, inline: true },
          { name: 'Moderator', value: `<@${message.author.id}>`, inline: true },
          { name: 'Reason', value: reason, inline: false },
          { name: 'Warning ID', value: `\`${data.id}\``, inline: true },
          { name: 'Total warnings', value: `${count ?? 1}`, inline: true }
        )
        .setTimestamp()
    );
  },
};

// ---------------------------------------------------------------------------
// *warns @user
// ---------------------------------------------------------------------------
export const warnsCommand: PrefixCommand = {
  name: 'warns',
  description: 'List warnings for a member',
  requiredPermissions: PermissionFlagsBits.ModerateMembers,
  async execute(message) {
    if (!message.guild) return;

    const target = parseUserTarget(message);
    if (!target) {
      return message.reply('Usage: `*warns @user`').catch(() => {});
    }

    const { data, error } = await supabase
      .from('warnings')
      .select('id, moderator_id, reason, created_at')
      .eq('guild_id', message.guild.id)
      .eq('user_id', target.id)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) {
      logger.error('[warns] read failed:', error.message);
      return message.reply('❌ Failed to fetch warnings.').catch(() => {});
    }

    if (!data || data.length === 0) {
      return message.reply(`<@${target.id}> has no warnings.`).catch(() => {});
    }

    const lines = data.map((w) => {
      const ts = Math.floor(new Date(w.created_at).getTime() / 1000);
      return `<t:${ts}:d> — <@${w.moderator_id}> — ${w.reason}\n-# \`${w.id}\``;
    });

    const embed = new EmbedBuilder()
      .setTitle(`Warnings for ${target.user.tag}`)
      .setColor(COLOR_WARN)
      .setDescription(lines.join('\n').slice(0, 4000))
      .setFooter({ text: `Showing up to 20 most recent` });

    await message.reply({ embeds: [embed] }).catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// *clearwarns @user [warning_id | all]
// Without a second arg, deletes ALL warnings.
// With a warning ID, deletes just that one.
// ---------------------------------------------------------------------------
export const clearwarnsCommand: PrefixCommand = {
  name: 'clearwarns',
  description: 'Clear all warnings or one warning for a member',
  guildAdminOnly: true,
  requiredPermissions: PermissionFlagsBits.ModerateMembers,
  async execute(message, args) {
    if (!message.guild) return;

    const target = parseUserTarget(message);
    if (!target) {
      return message.reply('Usage: `*clearwarns @user [warning_id | all]`').catch(() => {});
    }

    const second = args[1]?.toLowerCase();

    if (second && second !== 'all') {
      const { error } = await supabase
        .from('warnings')
        .delete()
        .eq('id', second)
        .eq('guild_id', message.guild.id)
        .eq('user_id', target.id);

      if (error) {
        logger.error('[clearwarns] single delete failed:', error.message);
        return message.reply('❌ Failed to delete warning.').catch(() => {});
      }
      return message
        .reply(`✅ Deleted warning \`${second}\` from <@${target.id}>.`)
        .catch(() => {});
    }

    const { count, error } = await supabase
      .from('warnings')
      .delete({ count: 'exact' })
      .eq('guild_id', message.guild.id)
      .eq('user_id', target.id);

    if (error) {
      logger.error('[clearwarns] bulk delete failed:', error.message);
      return message.reply('❌ Failed to clear warnings.').catch(() => {});
    }

    await message
      .reply(`✅ Cleared ${count ?? 0} warning(s) for <@${target.id}>.`)
      .catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// *kick @user [reason]
// ---------------------------------------------------------------------------
export const kickCommand: PrefixCommand = {
  name: 'kick',
  description: 'Kick a member',
  requiredPermissions: PermissionFlagsBits.KickMembers,
  async execute(message, args) {
    if (!message.guild || !message.member) return;

    const target = parseUserTarget(message);
    if (!target) {
      return message.reply('Usage: `*kick @user [reason]`').catch(() => {});
    }

    const hierarchyError = checkHierarchy(message.member, target, 'kick');
    if (hierarchyError) return message.reply(hierarchyError).catch(() => {});

    if (!target.kickable) {
      return message
        .reply('❌ I cannot kick this member — likely a role hierarchy issue.')
        .catch(() => {});
    }

    const reason = args.slice(1).join(' ').trim() || 'No reason provided';

    await target
      .send(
        `You were kicked from **${message.guild.name}**\nReason: ${reason}`
      )
      .catch(() => {});

    try {
      await target.kick(`${message.author.tag}: ${reason}`);
    } catch (err: any) {
      logger.error('[kick] failed:', err?.message ?? err);
      return message.reply('❌ Kick failed.').catch(() => {});
    }

    await message
      .reply(`✅ Kicked **${target.user.tag}** — ${reason}`)
      .catch(() => {});

    await logModAction(
      message.guild,
      new EmbedBuilder()
        .setTitle('Member Kicked')
        .setColor(COLOR_KICK)
        .addFields(
          { name: 'Member', value: `${target.user.tag} \`${target.id}\``, inline: true },
          { name: 'Moderator', value: `<@${message.author.id}>`, inline: true },
          { name: 'Reason', value: reason, inline: false }
        )
        .setTimestamp()
    );
  },
};

// ---------------------------------------------------------------------------
// *ban @user [reason] [days]
// `days` = how many days of messages to delete (0-7). Default 0.
// ---------------------------------------------------------------------------
export const banCommand: PrefixCommand = {
  name: 'ban',
  description: 'Ban a member',
  requiredPermissions: PermissionFlagsBits.BanMembers,
  async execute(message, args) {
    if (!message.guild || !message.member) return;

    const target = parseUserTarget(message);
    if (!target) {
      return message.reply('Usage: `*ban @user [reason] [days 0-7]`').catch(() => {});
    }

    const hierarchyError = checkHierarchy(message.member, target, 'ban');
    if (hierarchyError) return message.reply(hierarchyError).catch(() => {});

    if (!target.bannable) {
      return message
        .reply('❌ I cannot ban this member — likely a role hierarchy issue.')
        .catch(() => {});
    }

    // Last arg is days if it's a single digit 0-7.
    let days = 0;
    let reasonParts = args.slice(1);
    const last = reasonParts[reasonParts.length - 1];
    if (last && /^[0-7]$/.test(last)) {
      days = parseInt(last, 10);
      reasonParts = reasonParts.slice(0, -1);
    }
    const reason = reasonParts.join(' ').trim() || 'No reason provided';

    await target
      .send(`You were banned from **${message.guild.name}**\nReason: ${reason}`)
      .catch(() => {});

    try {
      await target.ban({ reason: `${message.author.tag}: ${reason}`, deleteMessageSeconds: days * 86400 });
    } catch (err: any) {
      logger.error('[ban] failed:', err?.message ?? err);
      return message.reply('❌ Ban failed.').catch(() => {});
    }

    await message
      .reply(`✅ Banned **${target.user.tag}** — ${reason}`)
      .catch(() => {});

    await logModAction(
      message.guild,
      new EmbedBuilder()
        .setTitle('Member Banned')
        .setColor(COLOR_BAN)
        .addFields(
          { name: 'Member', value: `${target.user.tag} \`${target.id}\``, inline: true },
          { name: 'Moderator', value: `<@${message.author.id}>`, inline: true },
          { name: 'Reason', value: reason, inline: false },
          { name: 'Messages deleted', value: `${days}d`, inline: true }
        )
        .setTimestamp()
    );
  },
};

// ---------------------------------------------------------------------------
// *unban <user_id> [reason]
// ---------------------------------------------------------------------------
export const unbanCommand: PrefixCommand = {
  name: 'unban',
  description: 'Unban a user by ID',
  requiredPermissions: PermissionFlagsBits.BanMembers,
  async execute(message, args) {
    if (!message.guild) return;

    const userId = args[0];
    if (!userId || !/^\d{17,20}$/.test(userId)) {
      return message.reply('Usage: `*unban <user_id> [reason]`').catch(() => {});
    }

    const reason = args.slice(1).join(' ').trim() || 'No reason provided';

    try {
      await message.guild.bans.remove(userId, `${message.author.tag}: ${reason}`);
    } catch (err: any) {
      logger.error('[unban] failed:', err?.message ?? err);
      return message
        .reply('❌ Unban failed — user may not be banned.')
        .catch(() => {});
    }

    await message.reply(`✅ Unbanned \`${userId}\` — ${reason}`).catch(() => {});

    await logModAction(
      message.guild,
      new EmbedBuilder()
        .setTitle('Member Unbanned')
        .setColor(COLOR_INFO)
        .addFields(
          { name: 'User ID', value: `\`${userId}\``, inline: true },
          { name: 'Moderator', value: `<@${message.author.id}>`, inline: true },
          { name: 'Reason', value: reason, inline: false }
        )
        .setTimestamp()
    );
  },
};

// ---------------------------------------------------------------------------
// *timeout @user <minutes> [reason]
// ---------------------------------------------------------------------------
export const timeoutCommand: PrefixCommand = {
  name: 'timeout',
  description: 'Timeout a member (max 40320 minutes = 28 days)',
  requiredPermissions: PermissionFlagsBits.ModerateMembers,
  async execute(message, args) {
    if (!message.guild || !message.member) return;

    const target = parseUserTarget(message);
    const minutesRaw = args[1];
    const minutes = parseInt(minutesRaw ?? '', 10);

    if (!target || isNaN(minutes) || minutes < 1 || minutes > 40320) {
      return message
        .reply('Usage: `*timeout @user <1-40320> [reason]`')
        .catch(() => {});
    }

    const hierarchyError = checkHierarchy(message.member, target, 'timeout');
    if (hierarchyError) return message.reply(hierarchyError).catch(() => {});

    if (!target.moderatable) {
      return message
        .reply('❌ I cannot timeout this member — likely a role hierarchy issue.')
        .catch(() => {});
    }

    const reason = args.slice(2).join(' ').trim() || 'No reason provided';
    const ms = minutes * 60 * 1000;

    try {
      await target.timeout(ms, `${message.author.tag}: ${reason}`);
    } catch (err: any) {
      logger.error('[timeout] failed:', err?.message ?? err);
      return message.reply('❌ Timeout failed.').catch(() => {});
    }

    await target
      .send(
        `You were timed out in **${message.guild.name}** for ${minutes} minute(s)\nReason: ${reason}`
      )
      .catch(() => {});

    await message
      .reply(`✅ Timed out <@${target.id}> for ${minutes}m — ${reason}`)
      .catch(() => {});

    await logModAction(
      message.guild,
      new EmbedBuilder()
        .setTitle('Member Timed Out')
        .setColor(COLOR_WARN)
        .addFields(
          { name: 'Member', value: `<@${target.id}> \`${target.id}\``, inline: true },
          { name: 'Moderator', value: `<@${message.author.id}>`, inline: true },
          { name: 'Duration', value: `${minutes} minute(s)`, inline: true },
          { name: 'Reason', value: reason, inline: false }
        )
        .setTimestamp()
    );
  },
};

// ---------------------------------------------------------------------------
// *purge <amount>  — delete up to 100 messages (must be recent enough)
// ---------------------------------------------------------------------------
export const purgeCommand: PrefixCommand = {
  name: 'purge',
  description: 'Delete recent messages in this channel',
  requiredPermissions: PermissionFlagsBits.ManageMessages,
  async execute(message, args) {
    if (!message.channel.isTextBased() || message.channel.isDMBased()) return;

    const amount = parseInt(args[0] ?? '', 10);
    if (isNaN(amount) || amount < 1 || amount > 100) {
      return message.reply('Usage: `*purge <1-100>`').catch(() => {});
    }

    const channel = message.channel as TextChannel;
    const deleted = await channel.bulkDelete(amount, true).catch(() => null);
    if (!deleted) {
      return message
        .reply('❌ Purge failed. Messages older than 14 days cannot be bulk-deleted.')
        .catch(() => {});
    }

    const reply = await message
      .reply(`✅ Deleted ${deleted.size} message(s).`)
      .catch(() => null);

    // Auto-cleanup the confirmation message after 4 seconds.
    if (reply) {
      setTimeout(() => reply.delete().catch(() => {}), 4000);
    }

    if (message.guild) {
      await logModAction(
        message.guild,
        new EmbedBuilder()
          .setTitle('Messages Purged')
          .setColor(COLOR_INFO)
          .addFields(
            { name: 'Channel', value: `<#${channel.id}>`, inline: true },
            { name: 'Moderator', value: `<@${message.author.id}>`, inline: true },
            { name: 'Count', value: `${deleted.size}`, inline: true }
          )
          .setTimestamp()
      );
    }
  },
};

// ---------------------------------------------------------------------------
// *slowmode <seconds>  — 0 disables slowmode
// ---------------------------------------------------------------------------
export const slowmodeCommand: PrefixCommand = {
  name: 'slowmode',
  description: 'Set slowmode in the current channel',
  requiredPermissions: PermissionFlagsBits.ManageChannels,
  async execute(message, args) {
    if (!message.channel.isTextBased() || message.channel.isDMBased()) return;

    const seconds = parseInt(args[0] ?? '', 10);
    if (isNaN(seconds) || seconds < 0 || seconds > 21600) {
      return message.reply('Usage: `*slowmode <0-21600>` (0 disables)').catch(() => {});
    }

    const channel = message.channel as TextChannel;
    try {
      await channel.setRateLimitPerUser(seconds);
    } catch (err: any) {
      logger.error('[slowmode] failed:', err?.message ?? err);
      return message.reply('❌ Failed to set slowmode.').catch(() => {});
    }

    await message
      .reply(
        seconds === 0
          ? '✅ Slowmode disabled.'
          : `✅ Slowmode set to ${seconds} second(s).`
      )
      .catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// Bulk export
// ---------------------------------------------------------------------------
export const moderationCommands: PrefixCommand[] = [
  warnCommand,
  warnsCommand,
  clearwarnsCommand,
  kickCommand,
  banCommand,
  unbanCommand,
  timeoutCommand,
  purgeCommand,
  slowmodeCommand,
];
