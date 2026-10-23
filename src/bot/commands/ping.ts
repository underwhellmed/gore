import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Message,
} from 'discord.js';
import { commandHandler, PrefixCommand } from '../commandHandler';
import { permissionService } from '../../services/permissionService';
import { config } from '../../config';

const COLOR = 0x5865f2; // Discord blurple
const MAX_FIELD_LENGTH = 1000;

/**
 * Shared builder used by both the `*help` prefix command and the `/help`
 * slash command. Only exposes admin commands if the caller is a bot admin.
 */
async function buildHelpEmbed(userId: string): Promise<EmbedBuilder> {
  const isBotAdmin = await permissionService.isBotAdmin(userId);

  const publicCmds = commandHandler
    .listPublic()
    .sort((a, b) => a.name.localeCompare(b.name));

  const embed = new EmbedBuilder()
    .setTitle('Bot Commands')
    .setColor(COLOR)
    .setDescription(
      `Prefix: \`${config.prefix}\` — All commands are prefix commands.\n` +
        `The only slash command is \`/help\`, which shows this menu.`
    )
    .setFooter({ text: 'Arguments in <angle brackets> are required.' });

  // Split public commands into fields of ≤1000 chars each, since Discord
  // caps a single embed field value at 1024 characters.
  let buffer = '';
  let fieldIndex = 1;

  const flush = () => {
    if (!buffer) return;
    embed.addFields({
      name: fieldIndex === 1 ? 'Commands' : `Commands (cont. ${fieldIndex})`,
      value: buffer,
      inline: false,
    });
    buffer = '';
    fieldIndex++;
  };

  for (const cmd of publicCmds) {
    const line = `\`${config.prefix}${cmd.name}\` — ${cmd.description}\n`;
    if (buffer.length + line.length > MAX_FIELD_LENGTH) flush();
    buffer += line;
  }
  flush();

  if (isBotAdmin) {
    const adminCmds = commandHandler
      .listAdmin()
      .sort((a, b) => a.name.localeCompare(b.name));

    let adminBuffer = '';
    let adminFieldIndex = 1;

    const flushAdmin = () => {
      if (!adminBuffer) return;
      embed.addFields({
        name:
          adminFieldIndex === 1
            ? '🔒 Bot admin commands'
            : `🔒 Bot admin commands (cont. ${adminFieldIndex})`,
        value: adminBuffer,
        inline: false,
      });
      adminBuffer = '';
      adminFieldIndex++;
    };

    for (const cmd of adminCmds) {
      const line = `\`${config.prefix}${cmd.name}\` — ${cmd.description}\n`;
      if (adminBuffer.length + line.length > MAX_FIELD_LENGTH) flushAdmin();
      adminBuffer += line;
    }
    flushAdmin();
  }

  return embed;
}

export const helpCommand: PrefixCommand = {
  name: 'help',
  description: 'Show the command list',
  requireGuild: false,
  async execute(message) {
    const embed = await buildHelpEmbed(message.author.id);
    await message.reply({ embeds: [embed] });
  },
};

/**
 * Slash-command handler for `/help`. Discord.js calls this from the
 * InteractionCreate handler, not from CommandHandler.
 */
export async function handleHelpSlash(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const embed = await buildHelpEmbed(interaction.user.id);

  // Optional: a "Refresh" button so the user can re-run /help without
  // retyping. Purely a convenience — the data is the same.
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('help_refresh')
      .setLabel('Refresh')
      .setStyle(ButtonStyle.Secondary)
  );

  await interaction.reply({ embeds: [embed], components: [row] });
}

/**
 * Handler for the "Refresh" button. Rebuilds the embed with the same
 * caller ID and edits the message in place.
 */
export async function handleHelpRefresh(
  interaction: import('discord.js').ButtonInteraction
): Promise<void> {
  const embed = await buildHelpEmbed(interaction.user.id);
  await interaction.update({ embeds: [embed] });
}
