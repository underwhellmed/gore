/**
 * Bot entry point.
 *
 * Ordering matters:
 *   1. Verify Supabase before anything touches the gateway — a bad URL or
 *      key should fail before Discord connects.
 *   2. Build the client (do not login yet).
 *   3. Register all prefix commands (sync, no I/O).
 *   4. Attach all event handlers (sync, no I/O).
 *   5. On ClientReady: register /help via REST, then start the giveaway loop.
 *   6. Login with the token.
 *
 * If anything in (1) fails, process.exit(1) fires and the panel console
 * shows the exact problem — no partial boot.
 */

import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';
import { config } from '../config';
import { logger } from '../utils/logger';
import { verifySupabaseConnection } from '../db/supabase';

import { commandHandler } from './commandHandler';

// ---- Command groups --------------------------------------------------------
import { helpCommand } from './commands/help';
import { pingCommand } from './commands/ping';
import { premiumCommand } from './commands/premium';
import { premiumAdminCommands } from './commands/premiumAdmin';
import { premiumCustomizeCommands } from './commands/premiumCustomize';
import { ticketCommands } from './commands/ticket';
import { welcomeCommands } from './commands/welcome';
import { loggingCommands } from './commands/logging';
import { moderationCommands } from './commands/moderation';
import { levelingCommands, awardMessageXp } from './commands/leveling';
import { giveawayCommands, startGiveawayLoop } from './commands/giveaway';
import { configCommands } from './commands/config';

// ---- Event handlers --------------------------------------------------------
import {
  messageCreateEvent,
  messageDeleteEvent,
  messageUpdateEvent,
} from './events/messageCreate';
import {
  guildMemberAddEvent,
  guildMemberRemoveEvent,
  guildCreateEvent,
  guildDeleteEvent,
} from './events/guildMemberAdd';
import { interactionCreateEvent } from './events/interactionCreate';

// ===========================================================================
// 1. Verify Supabase before boot.
// ===========================================================================
await verifySupabaseConnection();

// ===========================================================================
// 2. Build the client.
//
// Intents required:
//   - Guilds              — guild/member/channel events
//   - GuildMessages       — message create/delete/edit
//   - MessageContent      — PRIVILEGED, must be enabled in Dev Portal
//   - GuildMembers        — PRIVILEGED, needed for member join/leave
//   - GuildMessageReactions — giveaway reaction counting
//
// Partials required:
//   - Message    — edit/delete of uncached messages
//   - Channel    — events from uncached channels (DM channels etc.)
//   - Reaction   — giveaways on uncached messages
//   - GuildMember — leave events for uncached members
//   - User       — user data for partial members
// ===========================================================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [
    Partials.Message,
    Partials.Channel,
    Partials.Reaction,
    Partials.GuildMember,
    Partials.User,
  ],
});

// ===========================================================================
// 3. Register all prefix commands.
// ===========================================================================
commandHandler.registerAll([
  // Public
  helpCommand,
  pingCommand,
  premiumCommand,

  // Admin
  ...premiumAdminCommands,
  ...configCommands,

  // Guild admin
  ...premiumCustomizeCommands,
  ...ticketCommands,
  ...welcomeCommands,
  ...loggingCommands,
  ...moderationCommands,
  ...levelingCommands,
  ...giveawayCommands,
]);

// ===========================================================================
// 4. Attach event handlers.
// ===========================================================================
client.on(Events.MessageCreate, (m) => messageCreateEvent.execute(m));
client.on(Events.MessageDelete, (m) => messageDeleteEvent.execute(m));
client.on(Events.MessageUpdate, (o, n) => messageUpdateEvent.execute(o, n));

client.on(Events.GuildMemberAdd, (m) => guildMemberAddEvent.execute(m));
client.on(Events.GuildMemberRemove, (m) => guildMemberRemoveEvent.execute(m));
client.on(Events.GuildCreate, (g) => guildCreateEvent.execute(g));
client.on(Events.GuildDelete, (g) => guildDeleteEvent.execute(g));

client.on(Events.InteractionCreate, (i) => interactionCreateEvent.execute(i));

// ===========================================================================
// 5. ClientReady — one-time setup.
// ===========================================================================
client.once(Events.ClientReady, async (readyClient) => {
  logger.info(`[Bot] Logged in as ${readyClient.user.tag}`);
  logger.info(`[Bot] Serving ${readyClient.guilds.cache.size} guild(s)`);
  logger.info(`[Bot] Prefix: "${config.prefix}"`);

  // ---- Register /help ------------------------------------------------
  // Only /help is a slash command by design. Everything else is prefix.
  // PUT overwrites the full command set — safe to run on every boot.
  try {
    const rest = new REST({ version: '10' }).setToken(config.discord.token);
    await rest.put(Routes.applicationCommands(config.discord.clientId), {
      body: [
        new SlashCommandBuilder()
          .setName('help')
          .setDescription('Show the command list')
          .toJSON(),
      ],
    });
    logger.info('[Bot] Registered /help slash command.');
  } catch (err: any) {
    logger.error('[Bot] Failed to register /help:', err?.message ?? err);
    // Non-fatal — the bot still works, just without /help.
  }

  // ---- Start the giveaway poll loop ----------------------------------
  startGiveawayLoop(client);

  logger.info('[Bot] Ready.');
});

// ===========================================================================
// 6. Error / disconnect handling.
//
// Without these, a transient gateway error prints nothing and the bot
// silently reconnects (or worse, doesn't). These handlers make failures
// visible in the panel console.
// ===========================================================================
client.on(Events.Error, (err) => {
  logger.error('[Bot] Client error:', err?.message ?? err);
});

client.on(Events.Warn, (msg) => {
  logger.warn('[Bot] Client warning:', msg);
});

// ===========================================================================
// 7. Graceful shutdown.
//
// Bot-Hosting may send SIGTERM/SIGINT on restart or stop. Destroy the
// client cleanly so the gateway connection is closed and Discord knows the
// bot went offline — avoids "zombie" sessions that linger and block
// subsequent logins with "session invalid" errors.
// ===========================================================================
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`[Bot] Received ${signal} — shutting down.`);
  try {
    await client.destroy();
    logger.info('[Bot] Disconnected.');
  } catch (err: any) {
    logger.error('[Bot] Shutdown error:', err?.message ?? err);
  }
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// ===========================================================================
// 8. Global safety nets.
//
// An uncaught exception or unhandled rejection would otherwise print a raw
// stack trace and (on some Node/Bun versions) exit silently. Log first, then
// let the process continue if it's a rejection, or exit if it's an exception
// — an uncaught exception usually means the process is in an unknown state.
// ===========================================================================
process.on('unhandledRejection', (reason) => {
  logger.error('[Bot] Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  logger.error('[Bot] Uncaught exception — exiting:', err?.message ?? err);
  logger.error(err?.stack ?? '(no stack)');
  process.exit(1);
});

// ===========================================================================
// 9. Login.
// ===========================================================================
logger.info('[Bot] Connecting to Discord...');

client.login(config.discord.token).catch((err: any) => {
  logger.error('[Bot] Login failed:', err?.message ?? err);
  logger.error('Check DISCORD_TOKEN in the Bot-Hosting panel. Also verify:');
  logger.error('  • Message Content intent is enabled');
  logger.error('  • Server Members intent is enabled');
  logger.error('  • The bot is invited to at least one server (for gateway to be ready)');
  process.exit(1);
});

// Re-export for convenience — not used internally but lets any future
// file import the running client without a circular dependency.
export { client };
export { awardMessageXp };
