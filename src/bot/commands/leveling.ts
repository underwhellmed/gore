import {
  EmbedBuilder,
  Guild,
  GuildMember,
  Message,
  TextChannel,
} from 'discord.js';
import { PrefixCommand } from '../commandHandler';
import { supabase } from '../../db/supabase';
import { logger } from '../../utils/logger';

const COLOR = 0x5865f2;
const XP_MIN = 15;
const XP_MAX = 25;
const XP_COOLDOWN_MS = 60_000;
const DEFAULT_MULTIPLIER = 1;
const MAX_LEVEL = 1000;

// In-memory cooldowns keyed by `${guildId}:${userId}`.
// Lost on bot restart — acceptable for leveling (worst case: a user gets
// one extra XP award right after a reboot). Not worth a DB column.
const xpCooldowns = new Map<string, number>();

// Periodic prune so the Map doesn't grow unbounded for users who only
// message once and never come back. .unref() so this timer doesn't keep
// the process alive during shutdown.
setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of xpCooldowns) {
    if (now - ts > XP_COOLDOWN_MS * 2) xpCooldowns.delete(k);
  }
}, 5 * 60_000).unref();

/**
 * XP required to advance from `level` to `level + 1`.
 * Progression:
 *   0→1: 100     5→6: 375     10→11: 1100
 *   1→2: 155     6→7: 465     20→21: 3100
 *   2→3: 220     7→8: 565
 *   3→3: 295     8→9: 675
 *   4→5: 380     9→10: 795
 */
export function xpForLevel(level: number): number {
  return 5 * level * level + 50 * level + 100;
}

interface LevelRecord {
  xp: number;
  level: number;
}

interface LevelConfig {
  enabled: boolean;
  levelUpChannelId: string | null;
  multiplier: number;
}

async function getLevelConfig(guildId: string): Promise<LevelConfig> {
  const { data, error } = await supabase
    .from('guild_configs')
    .select('leveling_enabled, automations')
    .eq('guild_id', guildId)
    .maybeSingle();

  if (error) {
    logger.error('[leveling] config read failed:', error.message);
    return { enabled: false, levelUpChannelId: null, multiplier: DEFAULT_MULTIPLIER };
  }

  const auto = (data?.automations ?? {}) as Record<string, unknown>;
  const rawMultiplier = typeof auto.xp_multiplier === 'number' ? auto.xp_multiplier : DEFAULT_MULTIPLIER;
  const multiplier = Math.max(1, Math.min(5, rawMultiplier));

  return {
    enabled: data?.leveling_enabled === true,
    levelUpChannelId:
      typeof auto.level_up_channel_id === 'string' ? auto.level_up_channel_id : null,
    multiplier,
  };
}

async function getLevelRecord(guildId: string, userId: string): Promise<LevelRecord> {
  const { data, error } = await supabase
    .from('levels')
    .select('xp, level')
    .eq('guild_id', guildId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    logger.error('[leveling] record read failed:', error.message);
    return { xp: 0, level: 0 };
  }
  return (data as LevelRecord | null) ?? { xp: 0, level: 0 };
}

function renderProgressBar(ratio: number): string {
  const safeRatio = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(safeRatio * 20);
  const empty = 20 - filled;
  return `\`[${'█'.repeat(filled)}${'░'.repeat(empty)}]\` ${(safeRatio * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// awardMessageXp
//
// Called from the messageCreate event handler (file 25) on every message.
// Returns null if:
//   - leveling is disabled for the guild
//   - the author is a bot
//   - the author is within the cooldown window
//   - the DB write fails
// Otherwise returns the new { level, xp, leveledUp } state.
//
// On level-up, the announcement is posted here (not in the event handler),
// because the config we just loaded tells us exactly where to send it.
// ---------------------------------------------------------------------------
export async function awardMessageXp(
  guild: Guild,
  member: GuildMember
): Promise<{ level: number; xp: number; leveledUp: boolean } | null> {
  if (member.user.bot) return null;

  const cfg = await getLevelConfig(guild.id);
  if (!cfg.enabled) return null;

  const cooldownKey = `${guild.id}:${member.id}`;
  const now = Date.now();
  const lastAt = xpCooldowns.get(cooldownKey);
  if (lastAt && now - lastAt < XP_COOLDOWN_MS) return null;
  xpCooldowns.set(cooldownKey, now);

  const current = await getLevelRecord(guild.id, member.id);
  const baseGain = Math.floor(Math.random() * (XP_MAX - XP_MIN + 1)) + XP_MIN;
  const gained = Math.floor(baseGain * cfg.multiplier);

  let level = current.level;
  let xp = current.xp + gained;
  let leveledUp = false;

  // Multi-level jumps are possible (particularly with a multiplier), so loop.
  // The MAX_LEVEL guard prevents pathological infinite loops if the levels
  // table is ever manipulated externally.
  while (xp >= xpForLevel(level) && level < MAX_LEVEL) {
    xp -= xpForLevel(level);
    level++;
    leveledUp = true;
  }
  if (level >= MAX_LEVEL) xp = 0;

  const { error } = await supabase.from('levels').upsert({
    guild_id: guild.id,
    user_id: member.id,
    xp,
    level,
  });

  if (error) {
    logger.error('[leveling] upsert failed:', error.message);
    return null;
  }

  // Announce level-up if a channel is configured. Silent otherwise —
  // users can check with *rank any time.
  if (leveledUp && cfg.levelUpChannelId) {
    const channel = await guild.channels.fetch(cfg.levelUpChannelId).catch(() => null);
    if (channel && channel.isTextBased()) {
      await (channel as TextChannel)
        .send(`🎉 <@${member.id}> reached **level ${level}**!`)
        .catch(() => {});
    }
  }

  return { level, xp, leveledUp };
}

// ---------------------------------------------------------------------------
// *rank [@user]  —  alias: *level
// ---------------------------------------------------------------------------
export const rankCommand: PrefixCommand = {
  name: 'rank',
  aliases: ['level'],
  description: 'Show level, rank, and XP progress',
  async execute(message, args) {
    if (!message.guild) return;

    const target = message.mentions.members?.first() ?? message.member;
    if (!target) return;

    const cfg = await getLevelConfig(message.guild.id);
    if (!cfg.enabled) {
      return message.reply('❌ Leveling is disabled on this server.').catch(() => {});
    }

    const record = await getLevelRecord(message.guild.id, target.id);
    const needed = xpForLevel(record.level);
    const ratio = needed > 0 ? record.xp / needed : 0;

    // Rank = 1 + number of members strictly ahead (by level, then XP).
    const { count, error: rankError } = await supabase
      .from('levels')
      .select('guild_id', { count: 'exact', head: true })
      .eq('guild_id', message.guild.id)
      .or(`level.gt.${record.level},and(level.eq.${record.level},xp.gt.${record.xp})`);

    const rank = rankError ? null : (count ?? 0) + 1;

    const embed = new EmbedBuilder()
      .setTitle(`Rank — ${target.user.username}`)
      .setColor(COLOR)
      .setThumbnail(target.displayAvatarURL({ size: 128 }))
      .addFields(
        { name: 'Level', value: `${record.level}`, inline: true },
        { name: 'Rank', value: rank !== null ? `#${rank}` : '—', inline: true },
        { name: 'XP', value: `${record.xp} / ${needed}`, inline: true },
        { name: 'Progress', value: renderProgressBar(ratio), inline: false }
      );

    await message.reply({ embeds: [embed] }).catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// *leaderboard  —  aliases: *lb, *top
// ---------------------------------------------------------------------------
export const leaderboardCommand: PrefixCommand = {
  name: 'leaderboard',
  aliases: ['lb', 'top'],
  description: 'Show the top 10 members by level',
  async execute(message) {
    if (!message.guild) return;

    const cfg = await getLevelConfig(message.guild.id);
    if (!cfg.enabled) {
      return message.reply('❌ Leveling is disabled on this server.').catch(() => {});
    }

    const { data, error } = await supabase
      .from('levels')
      .select('user_id, xp, level')
      .eq('guild_id', message.guild.id)
      .order('level', { ascending: false })
      .order('xp', { ascending: false })
      .limit(10);

    if (error) {
      logger.error('[leaderboard] read failed:', error.message);
      return message.reply('❌ Failed to fetch leaderboard.').catch(() => {});
    }
    if (!data || data.length === 0) {
      return message.reply('Nobody has gained XP yet on this server.').catch(() => {});
    }

    const medals = ['🥇', '🥈', '🥉'];
    const lines = data.map((row, i) => {
      const prefix = medals[i] ?? `**#${i + 1}**`;
      return `${prefix} <@${row.user_id}> — Level **${row.level}** · ${row.xp} XP`;
    });

    const embed = new EmbedBuilder()
      .setTitle(`Leaderboard — ${message.guild.name}`)
      .setColor(COLOR)
      .setDescription(lines.join('\n'))
      .setFooter({ text: 'Top 10 · sorted by level, then XP' });

    await message.reply({ embeds: [embed] }).catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// *level-toggle
// ---------------------------------------------------------------------------
export const levelToggleCommand: PrefixCommand = {
  name: 'level-toggle',
  description: 'Enable or disable leveling for this server',
  guildAdminOnly: true,
  async execute(message) {
    if (!message.guild) return;

    const cfg = await getLevelConfig(message.guild.id);
    const newVal = !cfg.enabled;

    const { error } = await supabase.from('guild_configs').upsert({
      guild_id: message.guild.id,
      leveling_enabled: newVal,
    });

    if (error) {
      logger.error('[level-toggle] upsert failed:', error.message);
      return message.reply('❌ Failed to toggle leveling.').catch(() => {});
    }

    await message.reply(`✅ Leveling **${newVal ? 'enabled' : 'disabled'}**.`).catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// *level-channel <#channel> | none
// ---------------------------------------------------------------------------
export const levelChannelCommand: PrefixCommand = {
  name: 'level-channel',
  description: 'Set the channel for level-up announcements (or "none")',
  guildAdminOnly: true,
  async execute(message, args) {
    if (!message.guild) return;

    const raw = args[0];
    if (!raw) {
      return message
        .reply('Usage: `*level-channel <#channel>` or `*level-channel none`')
        .catch(() => {});
    }

    const { data, error } = await supabase
      .from('guild_configs')
      .select('automations')
      .eq('guild_id', message.guild.id)
      .maybeSingle();

    if (error) {
      logger.error('[level-channel] read failed:', error.message);
      return message.reply('❌ Failed to read config.').catch(() => {});
    }

    const current = (data?.automations ?? {}) as Record<string, unknown>;

    let levelUpChannelId: string | null = null;
    if (raw.toLowerCase() !== 'none') {
      const id = raw.replace(/[<#>]/g, '');
      const channel = message.guild.channels.cache.get(id);
      if (!channel || !channel.isTextBased()) {
        return message.reply('❌ Channel not found or not text-based.').catch(() => {});
      }
      levelUpChannelId = channel.id;
    }

    const next = { ...current, level_up_channel_id: levelUpChannelId };

    const { error: upErr } = await supabase
      .from('guild_configs')
      .upsert({ guild_id: message.guild.id, automations: next });

    if (upErr) {
      logger.error('[level-channel] upsert failed:', upErr.message);
      return message.reply('❌ Failed to save.').catch(() => {});
    }

    await message
      .reply(
        levelUpChannelId
          ? `✅ Level-up announcements will be sent to <#${levelUpChannelId}>.`
          : '✅ Level-up announcements disabled.'
      )
      .catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// *level-multiplier <1-5>  — premium
// ---------------------------------------------------------------------------
export const levelMultiplierCommand: PrefixCommand = {
  name: 'level-multiplier',
  description: 'Set the XP gain multiplier (premium, 1-5)',
  guildAdminOnly: true,
  requiresPremium: true,
  async execute(message, args) {
    if (!message.guild) return;

    const raw = parseFloat(args[0] ?? '');
    if (isNaN(raw) || raw < 1 || raw > 5) {
      return message
        .reply('Usage: `*level-multiplier <1-5>` — decimals allowed (e.g. `1.5`)')
        .catch(() => {});
    }

    const { data, error } = await supabase
      .from('guild_configs')
      .select('automations')
      .eq('guild_id', message.guild.id)
      .maybeSingle();

    if (error) {
      logger.error('[level-multiplier] read failed:', error.message);
      return message.reply('❌ Failed to read config.').catch(() => {});
    }

    const current = (data?.automations ?? {}) as Record<string, unknown>;
    const next = { ...current, xp_multiplier: raw };

    const { error: upErr } = await supabase
      .from('guild_configs')
      .upsert({ guild_id: message.guild.id, automations: next });

    if (upErr) {
      logger.error('[level-multiplier] upsert failed:', upErr.message);
      return message.reply('❌ Failed to save.').catch(() => {});
    }

    await message.reply(`✅ XP multiplier set to **${raw}x**.`).catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// *level-config
// ---------------------------------------------------------------------------
export const levelConfigCommand: PrefixCommand = {
  name: 'level-config',
  description: 'View the current leveling configuration',
  guildAdminOnly: true,
  async execute(message) {
    if (!message.guild) return;

    const cfg = await getLevelConfig(message.guild.id);

    const embed = new EmbedBuilder()
      .setTitle('Leveling Configuration')
      .setColor(cfg.enabled ? COLOR : 0x99aab5)
      .addFields(
        { name: 'Status', value: cfg.enabled ? '✅ Enabled' : '❌ Disabled', inline: true },
        {
          name: 'Level-up channel',
          value: cfg.levelUpChannelId ? `<#${cfg.levelUpChannelId}>` : '— (silent)',
          inline: true,
        },
        {
          name: 'XP multiplier',
          value: `${cfg.multiplier}x${cfg.multiplier > 1 ? ' (premium)' : ''}`,
          inline: true,
        },
        {
          name: 'XP per message',
          value: `${XP_MIN}–${XP_MAX} (× multiplier), ${XP_COOLDOWN_MS / 1000}s cooldown`,
          inline: false,
        }
      )
      .setFooter({
        text: 'Manage: *level-toggle · *level-channel · *level-multiplier (premium)',
      });

    await message.reply({ embeds: [embed] }).catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// *level-reset @user
// ---------------------------------------------------------------------------
export const levelResetCommand: PrefixCommand = {
  name: 'level-reset',
  description: "Reset a member's level and XP",
  guildAdminOnly: true,
  async execute(message) {
    if (!message.guild) return;

    const target = message.mentions.members?.first();
    if (!target) {
      return message.reply('Usage: `*level-reset @user`').catch(() => {});
    }

    const { error } = await supabase
      .from('levels')
      .delete()
      .eq('guild_id', message.guild.id)
      .eq('user_id', target.id);

    if (error) {
      logger.error('[level-reset] delete failed:', error.message);
      return message.reply('❌ Failed to reset.').catch(() => {});
    }

    await message.reply(`✅ Reset level and XP for <@${target.id}>.`).catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// Bulk export
// ---------------------------------------------------------------------------
export const levelingCommands: PrefixCommand[] = [
  rankCommand,
  leaderboardCommand,
  levelToggleCommand,
  levelChannelCommand,
  levelMultiplierCommand,
  levelConfigCommand,
  levelResetCommand,
];
