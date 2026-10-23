import { EmbedBuilder, Events, Message, PartialMessage } from 'discord.js';
import { commandHandler } from '../commandHandler';
import { awardMessageXp } from '../commands/leveling';
import { sendGuildLog } from '../commands/logging';
import { logger } from '../../utils/logger';

const COLOR_DELETE = 0xed4245;
const COLOR_EDIT = 0xfee75c;
const MAX_CONTENT_PREVIEW = 900;

function truncate(s: string, max = MAX_CONTENT_PREVIEW): string {
  if (!s) return '';
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * Skip a message for logging purposes. Returns true if we should NOT log.
 *
 * - DM messages have no guild — skip.
 * - Bot messages (including our own) — skip.
 * - Messages from the system (pins, joins, boosts) have no real author.
 */
function shouldSkipLog(
  message: Message | PartialMessage
): boolean {
  if (!message.guild) return true;
  if (!message.author) return true;
  if (message.author.bot) return true;
  return false;
}

// ===========================================================================
// MESSAGE CREATE
// Routes prefix commands and awards XP. Fire-and-forget for the XP award so
// a slow DB write never delays command handling.
// ===========================================================================
export const messageCreateEvent = {
  name: Events.MessageCreate,
  once: false,
  async execute(message: Message): Promise<void> {
    try {
      if (message.author.bot) return;
      if (!message.guild) return;
      if (!message.member) return;

      // XP award is best-effort and independent of command handling. If it
      // fails, the user sees nothing — leveling just skips this message.
      awardMessageXp(message.guild, message.member).catch((err) =>
        logger.debug('[messageCreate] XP award failed:', err?.message ?? err)
      );

      // Route prefix commands. commandHandler silently ignores messages that
      // don't start with the prefix, so this is cheap for every message.
      await commandHandler.handle(message);
    } catch (err: any) {
      // Event handlers must never throw — a throw here would propagate to
      // the discord.js event emitter and could kill the gateway connection.
      logger.error('[messageCreate] handler threw:', err?.message ?? err);
    }
  },
};

// ===========================================================================
// MESSAGE DELETE
// Logs deletions to the guild's log channel (if enabled).
//
// Note on partials: the bot needs the PartialMessage partial enabled (file 28)
// to receive delete events for messages it never cached. When it does receive
// a partial, the content is unrecoverable — we log what we can and mark the
// content as unavailable.
// ===========================================================================
export const messageDeleteEvent = {
  name: Events.MessageDelete,
  once: false,
  async execute(message: Message | PartialMessage): Promise<void> {
    try {
      if (shouldSkipLog(message)) return;
      if (!message.guild) return;
      if (!message.author) return;

      const content = message.partial
        ? '(content unavailable — message was not cached)'
        : message.content ?? '';

      // Skip empty messages that had no attachments either — nothing useful
      // to log, and they're often system noise.
      if (
        !content &&
        (!message.attachments || message.attachments.size === 0)
      ) {
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle('Message Deleted')
        .setColor(COLOR_DELETE)
        .setAuthor({
          name: message.author.tag ?? message.author.username,
          iconURL: message.author.displayAvatarURL({ size: 64 }),
        })
        .addFields(
          { name: 'Channel', value: `<#${message.channelId}>`, inline: true },
          { name: 'Author', value: `<@${message.author.id}>`, inline: true },
          { name: 'Message ID', value: `\`${message.id}\``, inline: true },
          {
            name: 'Content',
            value: content ? truncate(content) : '*(no text content)*',
            inline: false,
          }
        )
        .setFooter({ text: `Author ID: ${message.author.id}` })
        .setTimestamp();

      if (message.attachments && message.attachments.size > 0) {
        const attachmentsText = [...message.attachments.values()]
          .map((a) => `[${a.name}](${a.url})`)
          .join('\n')
          .slice(0, 1000);
        embed.addFields({
          name: `Attachments (${message.attachments.size})`,
          value: attachmentsText,
          inline: false,
        });
      }

      await sendGuildLog(message.guild.id, 'message_delete', embed, message.guild);
    } catch (err: any) {
      logger.error('[messageDelete] handler threw:', err?.message ?? err);
    }
  },
};

// ===========================================================================
// MESSAGE UPDATE (edit)
// Logs edits to the guild's log channel (if enabled).
//
// oldMessage may be partial (the original content was never cached). In that
// case we cannot reliably diff, so we label the "before" field as "(not cached)"
// rather than pretending it was empty.
// ===========================================================================
export const messageUpdateEvent = {
  name: Events.MessageUpdate,
  once: false,
  async execute(
    oldMessage: Message | PartialMessage,
    newMessage: Message | PartialMessage
  ): Promise<void> {
    try {
      if (shouldSkipLog(newMessage)) return;
      if (!newMessage.guild) return;
      if (!newMessage.author) return;

      const oldContent = oldMessage.content ?? '';
      const newContent = newMessage.content ?? '';

      // If content didn't change, this was an embed/pin/metadata update —
      // nothing a moderator cares about. Skip.
      if (oldContent === newContent) return;

      // Both empty: nothing to diff. Skip.
      if (!oldContent && !newContent) return;

      const oldDisplay = oldMessage.partial
        ? '*(not cached — original content unavailable)*'
        : oldContent
        ? truncate(oldContent)
        : '*(empty)*';

      const newDisplay = newContent
        ? truncate(newContent)
        : '*(empty)*';

      const embed = new EmbedBuilder()
        .setTitle('Message Edited')
        .setColor(COLOR_EDIT)
        .setAuthor({
          name: newMessage.author.tag ?? newMessage.author.username,
          iconURL: newMessage.author.displayAvatarURL({ size: 64 }),
        })
        .addFields(
          { name: 'Channel', value: `<#${newMessage.channelId}>`, inline: true },
          { name: 'Author', value: `<@${newMessage.author.id}>`, inline: true },
          { name: 'Jump', value: `[Go to message](${newMessage.url})`, inline: true },
          { name: 'Before', value: oldDisplay, inline: false },
          { name: 'After', value: newDisplay, inline: false }
        )
        .setFooter({ text: `Message ID: ${newMessage.id}` })
        .setTimestamp();

      await sendGuildLog(newMessage.guild.id, 'message_edit', embed, newMessage.guild);
    } catch (err: any) {
      logger.error('[messageUpdate] handler threw:', err?.message ?? err);
    }
  },
};
