import {
  ButtonInteraction,
  ChatInputCommandInteraction,
  Events,
  Interaction,
  MessageFlags,
  TextChannel,
} from 'discord.js';
import { supabase } from '../../db/supabase';
import { ticketService } from '../../services/ticketService';
import { handleHelpSlash, handleHelpRefresh } from '../commands/help';
import { logger } from '../../utils/logger';

/**
 * Single entry point for ALL interactions:
 *   - Chat input commands (only /help is registered)
 *   - Buttons (help_refresh, ticket_create)
 *   - Anything else — safely ignored
 *
 * Every path is wrapped in try/catch. An unhandled throw here can kill the
 * gateway connection, so this is deliberately defensive.
 */
export const interactionCreateEvent = {
  name: Events.InteractionCreate,
  once: false,
  async execute(interaction: Interaction): Promise<void> {
    try {
      // ---- Slash commands ------------------------------------------------
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'help') {
          await handleHelpSlash(interaction as ChatInputCommandInteraction);
          return;
        }
        // Only /help is registered. Anything else is stale or malicious.
        await reply(interaction, '❌ Unknown command.');
        return;
      }

      // ---- Buttons -------------------------------------------------------
      if (interaction.isButton()) {
        switch (interaction.customId) {
          case 'help_refresh':
            await handleHelpRefresh(interaction);
            return;

          case 'ticket_create':
            await handleTicketCreate(interaction);
            return;

          default:
            // Unknown button (e.g. from a removed feature) — silently ack.
            await interaction.deferUpdate().catch(() => {});
            return;
        }
      }

      // ---- Everything else ----------------------------------------------
      // Modals, select menus, autocomplete — not used in this bot.
      // Acknowledge so Discord doesn't show "interaction failed".
      if ('deferred' in interaction && !interaction.deferred && !('replied' in interaction && interaction.replied)) {
        await (interaction as any).deferUpdate?.().catch(() => {});
      }
    } catch (err: any) {
      logger.error('[interactionCreate] handler threw:', err?.message ?? err);

      // Best-effort user-facing error so they don't get a spinner hang.
      try {
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: '❌ An error occurred. Please try again.',
            flags: MessageFlags.Ephemeral,
          });
        } else if (interaction.isRepliable() && interaction.deferred && !interaction.replied) {
          await interaction.editReply({
            content: '❌ An error occurred. Please try again.',
          });
        }
      } catch {
        // If even the error reply fails, log and move on.
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Helper: reply ephemeral, swallowing "already replied" errors.
// ---------------------------------------------------------------------------
async function reply(interaction: Interaction, content: string): Promise<void> {
  if (!interaction.isRepliable()) return;
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Ticket creation flow
//
// Flow:
//   1. Validate guild context
//   2. Defer (channel creation + DB can exceed 3s interaction window)
//   3. Load ticket config from guild_configs
//   4. Validate category and staff role still exist (they can be deleted
//      after setup — this is the #1 "why did the ticket fail" issue)
//   5. Create channel via ticketService (handles permission overwrites,
//      DB insert, orphan cleanup)
//   6. Post a starter message in the ticket channel
//   7. Ephemeral confirmation to the user
// ---------------------------------------------------------------------------
async function handleTicketCreate(interaction: ButtonInteraction): Promise<void> {
  // ---- 1. Guild context -------------------------------------------------
  if (!interaction.guild) {
    await reply(interaction, '❌ Tickets can only be created in a server.');
    return;
  }

  // ---- 2. Defer --------------------------------------------------------
  // Ephemeral defer so the clicker gets a private "Thinking..." and no
  // other members see a loading state.
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  } catch (err: any) {
    // Clicking a dead interaction (e.g. the panel is >3s old after restart)
    // — nothing to do.
    logger.debug('[interactionCreate] ticket deferReply failed:', err?.message ?? err);
    return;
  }

  // ---- 3. Load ticket config ------------------------------------------
  const { data: cfg, error: cfgError } = await supabase
    .from('guild_configs')
    .select('ticket_category_id, ticket_staff_role_id')
    .eq('guild_id', interaction.guild.id)
    .maybeSingle();

  if (cfgError) {
    logger.error('[interactionCreate] ticket config read failed:', cfgError.message);
    await interaction.editReply({
      content: '❌ Failed to read ticket configuration. Please ask an admin to check the bot.',
    }).catch(() => {});
    return;
  }

  if (!cfg?.ticket_category_id || !cfg?.ticket_staff_role_id) {
    await interaction.editReply({
      content: '❌ The ticket system is not configured for this server. Ask an admin to run `*ticket-setup`.',
    }).catch(() => {});
    return;
  }

  // ---- 4. Validate category and role still exist ----------------------
  const category = await interaction.guild.channels
    .fetch(cfg.ticket_category_id)
    .catch(() => null);

  if (!category) {
    await interaction.editReply({
      content: '❌ The configured ticket category no longer exists. Ask an admin to run `*ticket-setup` again.',
    }).catch(() => {});
    return;
  }

  const staffRole = await interaction.guild.roles
    .fetch(cfg.ticket_staff_role_id)
    .catch(() => null);

  if (!staffRole) {
    await interaction.editReply({
      content: '❌ The configured staff role no longer exists. Ask an admin to run `*ticket-setup` again.',
    }).catch(() => {});
    return;
  }

  // ---- 5. Create the ticket -------------------------------------------
  try {
    const member = await interaction.guild.members.fetch(interaction.user.id);

    const channel = await ticketService.createTicket(
      interaction.guild,
      member,
      cfg.ticket_category_id,
      cfg.ticket_staff_role_id
    );

    // ---- 6. Starter message in the ticket channel ---------------------
    const starterMessage = [
      `<@${interaction.user.id}> — your ticket has been created.`,
      '',
      'A staff member will be with you shortly.',
      '',
      `**Close:** \`*ticket-close\``,
      `**Staff claim:** \`*ticket-claim\``,
    ].join('\n');

    await (channel as TextChannel)
      .send(starterMessage)
      .catch((err) =>
        logger.warn(
          '[interactionCreate] ticket starter message failed:',
          err?.message ?? err
        )
      );

    // ---- 7. Ephemeral confirmation ------------------------------------
    await interaction.editReply({
      content: `✅ Your ticket has been created: <#${channel.id}>`,
    }).catch(() => {});
  } catch (err: any) {
    const msg = err?.message ?? 'Failed to create ticket.';
    logger.error('[interactionCreate] ticket create failed:', msg);
    await interaction.editReply({ content: `❌ ${msg}` }).catch(() => {});
  }
}
