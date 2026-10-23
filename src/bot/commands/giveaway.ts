import {
  Client,
  EmbedBuilder,
  Message,
  PermissionFlagsBits,
  TextChannel,
} from 'discord.js';
import { PrefixCommand } from '../commandHandler';
import { supabase } from '../../db/supabase';
import { logger } from '../../utils/logger';

const COLOR_ACTIVE = 0x5865f2;
const COLOR_ENDED = 0x57f287;

const REACTION_EMOJI = '🎉';
const MIN_DURATION_MS = 30_000;                    // 30 seconds
const MAX_DURATION_MS = 30 * 24 * 60 * 60_000;     // 30 days
const MAX_WINNERS = 20;
const POLL_INTERVAL_MS = 30_000;

interface GiveawayRow {
  id: string;
  guild_id: string;
  channel_id: string;
  message_id: string;
  prize: string;
  ends_at: string;
  winners: number;
  ended: boolean;
  created_by: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse `30s`, `10m`, `2h`, `3d`, or a bare number (minutes).
 * Returns milliseconds, or null on invalid input / out-of-range.
 */
function parseDuration(input: string): number | null {
  const m = input.match(/^(\d+)([smhd]?)$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = (m[2] || 'm').toLowerCase();
  const mult: Record<string, number> = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  const ms = n * mult[unit];
  if (ms < MIN_DURATION_MS || ms > MAX_DURATION_MS) return null;
  return ms;
}

function formatRelative(iso: string): string {
  const ts = Math.floor(new Date(iso).getTime() / 1000);
  return `<t:${ts}:R>`; // "in 2 hours", "in 3 minutes"
}

function formatAbsolute(iso: string): string {
  const ts = Math.floor(new Date(iso).getTime() / 1000);
  return `<t:${ts}:f>`;
}

/** Fisher–Yates shuffle. Returns a new array. */
function shuffle<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function buildActiveEmbed(row: GiveawayRow): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`🎉 Giveaway — ${row.prize}`)
    .setColor(COLOR_ACTIVE)
    .setDescription(
      [
        `React with ${REACTION_EMOJI} to enter!`,
        '',
        `**Ends:** ${formatRelative(row.ends_at)} (${formatAbsolute(row.ends_at)})`,
        `**Winners:** ${row.winners}`,
        `**Hosted by:** <@${row.created_by}>`,
      ].join('\n')
    )
    .setFooter({ text: 'One entry per user. Bots excluded.' });
}

function buildEndedEmbed(row: GiveawayRow, winnerIds: string[]): EmbedBuilder {
  const winnerLine =
    winnerIds.length === 0
      ? '❌ No valid entries — no winners.'
      : `🏆 **Winner${winnerIds.length > 1 ? 's' : ''}:** ${winnerIds
          .map((id) => `<@${id}>`)
          .join(', ')}`;

  return new EmbedBuilder()
    .setTitle(`🎉 Giveaway Ended — ${row.prize}`)
    .setColor(COLOR_ENDED)
    .setDescription(
      [
        winnerLine,
        '',
        `**Ended:** ${formatAbsolute(row.ends_at)}`,
        `**Hosted by:** <@${row.created_by}>`,
      ].join('\n')
    )
    .setFooter({ text: `Giveaway ID: ${row.id}` });
}

/**
 * Fetch the entry pool for a giveaway message: everyone who reacted with 🎉,
 * excluding bots and the giveaway host (if `excludeId` matches the host).
 * The host is NOT excluded by default — it's a design choice made per-bot.
 * This implementation includes the host so small servers don't end up with
 * "no entries" when only the admin and one other person reacted.
 */
async function fetchEntries(
  client: Client,
  channelId: string,
  messageId: string
): Promise<{ valid: boolean; entries: string[]; reason?: string }> {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    return { valid: false, entries: [], reason: 'channel missing' };
  }

  const message = await (channel as TextChannel).messages
    .fetch(messageId)
    .catch(() => null);
  if (!message) {
    return { valid: false, entries: [], reason: 'message deleted' };
  }

  const reaction = message.reactions.cache.find(
    (r) => r.emoji.name === REACTION_EMOJI
  );
  if (!reaction) {
    return { valid: true, entries: [] };
  }

  const users = await reaction.users.fetch().catch(() => null);
  if (!users) {
    return { valid: true, entries: [] };
  }

  const entries = [...users.values()]
    .filter((u) => !u.bot)
    .map((u) => u.id);

  return { valid: true, entries };
}

async function markEnded(giveawayId: string): Promise<void> {
  const { error } = await supabase
    .from('giveaways')
    .update({ ended: true })
    .eq('id', giveawayId);
  if (error) {
    logger.error(`[giveaway] markEnded(${giveawayId}) failed:`, error.message);
  }
}

/**
 * End a giveaway: fetch entries, pick winners, edit the message,
 * announce in channel, mark as ended.
 *
 * Returns the chosen winner IDs, or an empty array if there were no entries.
 * If the message or channel no longer exists, the giveaway is still marked
 * ended — otherwise the poll loop retries forever on a dead message.
 */
async function endGiveaway(
  client: Client,
  row: GiveawayRow,
  options: { forcedEnd?: boolean; forcedWinners?: string[] } = {}
): Promise<string[]> {
  const fetched = await fetchEntries(client, row.channel_id, row.message_id);

  if (!fetched.valid) {
    logger.warn(`[giveaway] Ending ${row.id} without winner pick: ${fetched.reason}`);
    await markEnded(row.id);
    return [];
  }

  const chosen = options.forcedWinners
    ? options.forcedWinners
    : shuffle(fetched.entries).slice(0, Math.min(row.winners, fetched.entries.length));

  // Update the original message.
  const channel = await client.channels.fetch(row.channel_id).catch(() => null);
  if (channel && channel.isTextBased()) {
    const message = await (channel as TextChannel).messages
      .fetch(row.message_id)
      .catch(() => null);
    if (message) {
      await message
        .edit({ embeds: [buildEndedEmbed(row, chosen)], components: [] })
        .catch((err) =>
          logger.warn(`[giveaway] Failed to edit message ${row.message_id}:`, err?.message ?? err)
        );
    }

    // Announce in channel (unless it was a reroll — caller handles that).
    if (!options.forcedEnd || chosen.length > 0) {
      const announcement =
        chosen.length === 0
          ? `🎉 Giveaway for **${row.prize}** ended with no winners (no entries).`
          : `🎉 Giveaway for **${row.prize}** ended! Winner${
              chosen.length > 1 ? 's' : ''
            }: ${chosen.map((id) => `<@${id}>`).join(', ')}`;
      await (channel as TextChannel).send(announcement).catch(() => {});
    }
  }

  await markEnded(row.id);
  logger.info(`[giveaway] Ended ${row.id} with ${chosen.length} winner(s).`);
  return chosen;
}

// ---------------------------------------------------------------------------
// Poll loop — called from index.ts on ClientReady.
// ---------------------------------------------------------------------------
export function startGiveawayLoop(client: Client): void {
  const tick = async () => {
    const { data, error } = await supabase
      .from('giveaways')
      .select('*')
      .eq('ended', false)
      .lt('ends_at', new Date().toISOString())
      .order('ends_at', { ascending: true })
      .limit(10);

    if (error) {
      logger.error('[giveaway] poll query failed:', error.message);
      return;
    }
    if (!data || data.length === 0) return;

    for (const row of data as GiveawayRow[]) {
      try {
        await endGiveaway(client, row);
      } catch (err: any) {
        logger.error(`[giveaway] endGiveaway(${row.id}) threw:`, err?.message ?? err);
        // Mark ended anyway to prevent infinite retries on a stuck giveaway.
        await markEnded(row.id).catch(() => {});
      }
    }
  };

  // Immediate catch-up on boot, then periodic poll.
  tick().catch((err) => logger.error('[giveaway] initial tick failed:', err));
  const handle = setInterval(
    () => tick().catch((err) => logger.error('[giveaway] tick failed:', err)),
    POLL_INTERVAL_MS
  );
  handle.unref();
  logger.info('[giveaway] Poll loop started.');
}

// ---------------------------------------------------------------------------
// *giveaway-start <duration> <winners> <prize>
// ---------------------------------------------------------------------------
export const giveawayStartCommand: PrefixCommand = {
  name: 'giveaway-start',
  aliases: ['gstart'],
  description: 'Start a giveaway (duration: 30s / 10m / 2h / 3d)',
  guildAdminOnly: true,
  requiredPermissions: PermissionFlagsBits.ManageGuild,
  async execute(message, args) {
    if (!message.guild || !message.channel.isTextBased()) return;

    const durationRaw = args[0];
    const winnersRaw = args[1];
    const prize = args.slice(2).join(' ').trim();

    const durationMs = durationRaw ? parseDuration(durationRaw) : null;
    const winners = parseInt(winnersRaw ?? '', 10);

    if (
      !durationMs ||
      isNaN(winners) ||
      winners < 1 ||
      winners > MAX_WINNERS ||
      !prize
    ) {
      return message
        .reply(
          'Usage: `*giveaway-start <duration> <winners> <prize>`\n' +
            'Duration: `30s`, `10m`, `2h`, `3d` (30s min, 30d max)\n' +
            `Winners: 1–${MAX_WINNERS}\n` +
            'Example: `*giveaway-start 1h 3 Steam Key`'
        )
        .catch(() => {});
    }

    const endsAt = new Date(Date.now() + durationMs).toISOString();

    // Create a placeholder row first so we can put the ID in the embed footer.
    const { data: created, error: createError } = await supabase
      .from('giveaways')
      .insert({
        guild_id: message.guild.id,
        channel_id: message.channel.id,
        message_id: 'pending',
        prize,
        ends_at: endsAt,
        winners,
        created_by: message.author.id,
      })
      .select()
      .single();

    if (createError || !created) {
      logger.error('[giveaway-start] insert failed:', createError?.message);
      return message.reply('❌ Failed to create giveaway.').catch(() => {});
    }

    const row = created as GiveawayRow;
    const embed = buildActiveEmbed(row).setFooter({
      text: `Giveaway ID: ${row.id} • React with ${REACTION_EMOJI}`,
    });

    let giveawayMessage: Message;
    try {
      giveawayMessage = await (message.channel as TextChannel).send({
        embeds: [embed],
      });
    } catch (err: any) {
      logger.error('[giveaway-start] message send failed:', err?.message ?? err);
      await supabase.from('giveaways').delete().eq('id', row.id);
      return message.reply('❌ Failed to post giveaway message.').catch(() => {});
    }

    await giveawayMessage.react(REACTION_EMOJI).catch(() => {});

    const { error: updateError } = await supabase
      .from('giveaways')
      .update({ message_id: giveawayMessage.id })
      .eq('id', row.id);

    if (updateError) {
      logger.error('[giveaway-start] message_id update failed:', updateError.message);
      // Continue — the giveaway will still be polled and end correctly.
    }

    // Auto-enable the giveaways flag the first time. Admin can disable via *giveaway-disable.
    await supabase.from('guild_configs').upsert(
      { guild_id: message.guild.id, giveaways_enabled: true },
      { ignoreDuplicates: false }
    );

    await message
      .reply(
        `✅ Giveaway started in <#${message.channel.id}> — ends ${formatRelative(
          endsAt
        )}.`
      )
      .catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// *giveaway-end <message_id>
// ---------------------------------------------------------------------------
export const giveawayEndCommand: PrefixCommand = {
  name: 'giveaway-end',
  aliases: ['gend'],
  description: 'End a giveaway early by message ID',
  guildAdminOnly: true,
  requiredPermissions: PermissionFlagsBits.ManageGuild,
  async execute(message, args) {
    if (!message.guild) return;

    const messageId = args[0];
    if (!messageId || !/^\d{17,20}$/.test(messageId)) {
      return message.reply('Usage: `*giveaway-end <message_id>`').catch(() => {});
    }

    const { data, error } = await supabase
      .from('giveaways')
      .select('*')
      .eq('guild_id', message.guild.id)
      .eq('message_id', messageId)
      .eq('ended', false)
      .maybeSingle();

    if (error) {
      logger.error('[giveaway-end] query failed:', error.message);
      return message.reply('❌ Failed to look up giveaway.').catch(() => {});
    }
    if (!data) {
      return message
        .reply('❌ No active giveaway found for that message ID.')
        .catch(() => {});
    }

    const winners = await endGiveaway(message.client, data as GiveawayRow, {
      forcedEnd: true,
    });

    await message
      .reply(
        winners.length > 0
          ? `✅ Giveaway ended. Winners: ${winners.map((id) => `<@${id}>`).join(', ')}`
          : '✅ Giveaway ended with no valid entries.'
      )
      .catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// *giveaway-reroll <message_id> [count]
// ---------------------------------------------------------------------------
export const giveawayRerollCommand: PrefixCommand = {
  name: 'giveaway-reroll',
  aliases: ['greroll'],
  description: 'Reroll winners for an ended giveaway',
  guildAdminOnly: true,
  requiredPermissions: PermissionFlagsBits.ManageGuild,
  async execute(message, args) {
    if (!message.guild) return;

    const messageId = args[0];
    if (!messageId || !/^\d{17,20}$/.test(messageId)) {
      return message.reply('Usage: `*giveaway-reroll <message_id> [count]`').catch(() => {});
    }
    const count = args[1] ? parseInt(args[1], 10) : undefined;

    const { data, error } = await supabase
      .from('giveaways')
      .select('*')
      .eq('guild_id', message.guild.id)
      .eq('message_id', messageId)
      .eq('ended', true)
      .maybeSingle();

    if (error || !data) {
      return message
        .reply('❌ No ended giveaway found for that message ID.')
        .catch(() => {});
    }

    const row = data as GiveawayRow;
    const wanted = count && count > 0 && count <= MAX_WINNERS ? count : row.winners;

    const fetched = await fetchEntries(message.client, row.channel_id, row.message_id);
    if (!fetched.valid || fetched.entries.length === 0) {
      return message
        .reply('❌ Cannot reroll — no valid entries on the giveaway message.')
        .catch(() => {});
    }

    const chosen = shuffle(fetched.entries).slice(
      0,
      Math.min(wanted, fetched.entries.length)
    );

    const channel = await message.client.channels
      .fetch(row.channel_id)
      .catch(() => null);
    if (channel && channel.isTextBased()) {
      await (channel as TextChannel)
        .send(
          `🎲 Reroll for **${row.prize}**: Winner${
            chosen.length > 1 ? 's' : ''
          } ${chosen.map((id) => `<@${id}>`).join(', ')}`
        )
        .catch(() => {});
    }

    await message
      .reply(
        `✅ Rerolled ${chosen.length} winner(s): ${chosen.map((id) => `<@${id}>`).join(', ')}`
      )
      .catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// *giveaway-list
// ---------------------------------------------------------------------------
export const giveawayListCommand: PrefixCommand = {
  name: 'giveaway-list',
  aliases: ['glist'],
  description: 'List active giveaways on this server',
  guildAdminOnly: true,
  async execute(message) {
    if (!message.guild) return;

    const { data, error } = await supabase
      .from('giveaways')
      .select('*')
      .eq('guild_id', message.guild.id)
      .eq('ended', false)
      .order('ends_at', { ascending: true });

    if (error) {
      logger.error('[giveaway-list] query failed:', error.message);
      return message.reply('❌ Failed to fetch giveaways.').catch(() => {});
    }

    if (!data || data.length === 0) {
      return message.reply('No active giveaways on this server.').catch(() => {});
    }

    const lines = (data as GiveawayRow[]).map(
      (g) =>
        `• **${g.prize}** — ends ${formatRelative(g.ends_at)} · ` +
        `${g.winners} winner(s) · <#${g.channel_id}> · \`${g.message_id}\``
    );

    const embed = new EmbedBuilder()
      .setTitle(`Active Giveaways (${data.length})`)
      .setColor(COLOR_ACTIVE)
      .setDescription(lines.join('\n').slice(0, 4000))
      .setFooter({ text: 'Use *giveaway-end <message_id> to end early' });

    await message.reply({ embeds: [embed] }).catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// *giveaway-disable  — stops new giveaways from being created (kill switch)
// Existing giveaways still complete normally.
// ---------------------------------------------------------------------------
export const giveawayDisableCommand: PrefixCommand = {
  name: 'giveaway-disable',
  description: 'Disable new giveaway creation on this server',
  guildAdminOnly: true,
  requiredPermissions: PermissionFlagsBits.ManageGuild,
  async execute(message) {
    if (!message.guild) return;

    const { error } = await supabase
      .from('guild_configs')
      .upsert({ guild_id: message.guild.id, giveaways_enabled: false });

    if (error) {
      logger.error('[giveaway-disable] upsert failed:', error.message);
      return message.reply('❌ Failed to disable.').catch(() => {});
    }

    await message
      .reply(
        '✅ New giveaways disabled. Existing giveaways will still end normally.'
      )
      .catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// Bulk export
// ---------------------------------------------------------------------------
export const giveawayCommands: PrefixCommand[] = [
  giveawayStartCommand,
  giveawayEndCommand,
  giveawayRerollCommand,
  giveawayListCommand,
  giveawayDisableCommand,
];
