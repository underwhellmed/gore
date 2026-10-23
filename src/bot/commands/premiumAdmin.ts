import { EmbedBuilder, Message } from 'discord.js';
import { PrefixCommand } from '../commandHandler';
import { entitlementService, Entitlement } from '../../services/entitlementService';
import { auditService } from '../../services/auditService';

// Discord snowflakes are 17–20 digit numeric strings. This is a hard
// validation boundary — everything below assumes the ID is well-formed.
const DISCORD_ID_RE = /^\d{17,20}$/;

function isDiscordId(id: string | undefined): id is string {
  return !!id && DISCORD_ID_RE.test(id);
}

function formatTs(iso: string | null): string {
  if (!iso) return '—';
  const ts = Math.floor(new Date(iso).getTime() / 1000);
  return `<t:${ts}:f>`;
}

async function replyUsage(message: Message, usage: string): Promise<void> {
  await message.reply(`Usage: \`${usage}\``).catch(() => {});
}

// ---------------------------------------------------------------------------
// *sp <server_id> [reason]
// ---------------------------------------------------------------------------
export const spCommand: PrefixCommand = {
  name: 'sp',
  aliases: ['grant-server'],
  description: 'Grant Server Premium to a server (permanent)',
  adminOnly: true,
  requireGuild: false,
  async execute(message, args) {
    const guildId = args[0];
    if (!isDiscordId(guildId)) return replyUsage(message, '*sp <server_id> [reason]');

    const reason = args.slice(1).join(' ') || undefined;

    try {
      await entitlementService.grantServerPremium(guildId, message.author.id, reason);
    } catch (err: any) {
      // Common failure: already has an active entitlement.
      await message.reply(`❌ ${err.message}`).catch(() => {});
      return;
    }

    await auditService.log(message.author.id, 'grant_server_premium', guildId, {
      reason: reason ?? null,
    });

    await message
      .reply(`✅ Server Premium granted to \`${guildId}\` (permanent).`)
      .catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// *up <user_id> [reason]
// ---------------------------------------------------------------------------
export const upCommand: PrefixCommand = {
  name: 'up',
  aliases: ['grant-user'],
  description: 'Grant User Premium to a user (permanent)',
  adminOnly: true,
  requireGuild: false,
  async execute(message, args) {
    const userId = args[0];
    if (!isDiscordId(userId)) return replyUsage(message, '*up <user_id> [reason]');

    const reason = args.slice(1).join(' ') || undefined;

    try {
      await entitlementService.grantUserPremium(userId, message.author.id, reason);
    } catch (err: any) {
      await message.reply(`❌ ${err.message}`).catch(() => {});
      return;
    }

    await auditService.log(message.author.id, 'grant_user_premium', userId, {
      reason: reason ?? null,
    });

    await message
      .reply(`✅ User Premium granted to \`${userId}\` (permanent).`)
      .catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// *revoke-server <server_id> [reason]
// ---------------------------------------------------------------------------
export const revokeServerCommand: PrefixCommand = {
  name: 'revoke-server',
  description: 'Revoke Server Premium from a server',
  adminOnly: true,
  requireGuild: false,
  async execute(message, args) {
    const guildId = args[0];
    if (!isDiscordId(guildId)) return replyUsage(message, '*revoke-server <server_id> [reason]');

    const reason = args.slice(1).join(' ') || undefined;

    const revoked = await entitlementService.revokeServerPremium(
      guildId,
      message.author.id,
      reason
    );

    if (!revoked) {
      await message.reply(`⚠️ No active Server Premium found for \`${guildId}\`.`).catch(() => {});
      return;
    }

    await auditService.log(message.author.id, 'revoke_server_premium', guildId, {
      reason: reason ?? null,
    });

    await message.reply(`✅ Server Premium revoked for \`${guildId}\`.`).catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// *revoke-user <user_id> [reason]
// ---------------------------------------------------------------------------
export const revokeUserCommand: PrefixCommand = {
  name: 'revoke-user',
  description: 'Revoke User Premium from a user',
  adminOnly: true,
  requireGuild: false,
  async execute(message, args) {
    const userId = args[0];
    if (!isDiscordId(userId)) return replyUsage(message, '*revoke-user <user_id> [reason]');

    const reason = args.slice(1).join(' ') || undefined;

    const revoked = await entitlementService.revokeUserPremium(
      userId,
      message.author.id,
      reason
    );

    if (!revoked) {
      await message.reply(`⚠️ No active User Premium found for \`${userId}\`.`).catch(() => {});
      return;
    }

    await auditService.log(message.author.id, 'revoke_user_premium', userId, {
      reason: reason ?? null,
    });

    await message.reply(`✅ User Premium revoked for \`${userId}\`.`).catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// *premium <server_id> | *userpremium <user_id>
// Inspect a single active entitlement.
// ---------------------------------------------------------------------------
function buildInspectionEmbed(
  title: string,
  ownerLabel: string,
  ownerId: string,
  ent: Entitlement | null
): EmbedBuilder {
  const embed = new EmbedBuilder().setTitle(title);
  if (!ent) {
    return embed
      .setColor(0x99aab5)
      .setDescription(`No active entitlement for ${ownerLabel} \`${ownerId}\`.`);
  }
  return embed
    .setColor(0x57f287)
    .addFields(
      { name: ownerLabel, value: `\`${ownerId}\``, inline: false },
      { name: 'Status', value: ent.status, inline: true },
      { name: 'Granted', value: formatTs(ent.granted_at), inline: true },
      { name: 'Granted by', value: `<@${ent.granted_by}>`, inline: true },
      { name: 'Reason', value: ent.grant_reason ?? '—', inline: false },
      { name: 'Entitlement ID', value: `\`${ent.entitlement_id}\``, inline: false }
    );
}

export const inspectServerCommand: PrefixCommand = {
  name: 'premium',
  description: 'Inspect Server Premium for a server',
  adminOnly: true,
  requireGuild: false,
  async execute(message, args) {
    const guildId = args[0];
    if (!isDiscordId(guildId)) return replyUsage(message, '*premium <server_id>');
    const ent = await entitlementService.getActiveEntitlement('server', guildId);
    const embed = buildInspectionEmbed('Server Premium', 'Server', guildId, ent);
    await message.reply({ embeds: [embed] }).catch(() => {});
  },
};

export const inspectUserCommand: PrefixCommand = {
  name: 'userpremium',
  description: 'Inspect User Premium for a user',
  adminOnly: true,
  requireGuild: false,
  async execute(message, args) {
    const userId = args[0];
    if (!isDiscordId(userId)) return replyUsage(message, '*userpremium <user_id>');
    const ent = await entitlementService.getActiveEntitlement('user', userId);
    const embed = buildInspectionEmbed('User Premium', 'User', userId, ent);
    await message.reply({ embeds: [embed] }).catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// *premium-list
// ---------------------------------------------------------------------------
export const premiumListCommand: PrefixCommand = {
  name: 'premium-list',
  description: 'List active premium entitlements',
  adminOnly: true,
  requireGuild: false,
  async execute(message) {
    const entitlements = await entitlementService.listActiveEntitlements(30);
    if (entitlements.length === 0) {
      await message.reply('No active entitlements.').catch(() => {});
      return;
    }

    const lines = entitlements.map((e) => {
      const label = e.premium_type === 'server' ? '🏠' : '👤';
      const target =
        e.premium_type === 'server' ? `<#${'0'}> \`${e.owner_id}\`` : `<@${e.owner_id}>`;
      // Channel mention above is nonsense — use plain display below.
      return `${label} **${e.premium_type}** \`${e.owner_id}\` — ${formatTs(e.granted_at)}`;
    });

    const embed = new EmbedBuilder()
      .setTitle(`Active Entitlements (${entitlements.length})`)
      .setColor(0x5865f2)
      .setDescription(lines.join('\n').slice(0, 4000))
      .setFooter({ text: 'Showing up to 30 most recent' });

    await message.reply({ embeds: [embed] }).catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// *premium-search <id>
// Find by server ID or user ID — searches both active and revoked.
// ---------------------------------------------------------------------------
export const premiumSearchCommand: PrefixCommand = {
  name: 'premium-search',
  description: 'Find entitlements by server or user ID',
  adminOnly: true,
  requireGuild: false,
  async execute(message, args) {
    const id = args[0];
    if (!isDiscordId(id)) return replyUsage(message, '*premium-search <id>');

    // Search both premium types, active and historical.
    const results = await Promise.all([
      entitlementService.getActiveEntitlement('server', id),
      entitlementService.getActiveEntitlement('user', id),
    ]);

    const active = results.filter((e): e is Entitlement => e !== null);

    if (active.length === 0) {
      await message.reply(`No active entitlement for \`${id}\`.`).catch(() => {});
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(`Entitlements for ${id}`)
      .setColor(0x57f287)
      .setDescription(
        active
          .map(
            (e) =>
              `**${e.premium_type}** — granted ${formatTs(e.granted_at)} by <@${e.granted_by}>\n` +
              `-# Entitlement \`${e.entitlement_id}\``
          )
          .join('\n\n')
      );

    await message.reply({ embeds: [embed] }).catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// *premium-history <id>
// ---------------------------------------------------------------------------
export const premiumHistoryCommand: PrefixCommand = {
  name: 'premium-history',
  description: 'View audit history for a server or user ID',
  adminOnly: true,
  requireGuild: false,
  async execute(message, args) {
    const id = args[0];
    if (!isDiscordId(id)) return replyUsage(message, '*premium-history <id>');

    const entries = await auditService.forTarget(id, 30);
    if (entries.length === 0) {
      await message.reply(`No audit history for \`${id}\`.`).catch(() => {});
      return;
    }

    const lines = entries.map(
      (e) =>
        `${formatTs(e.created_at)} — <@${e.actor_id}> — \`${e.action}\`` +
        (e.details && typeof e.details === 'object' && 'reason' in e.details
          ? ` — ${String((e.details as Record<string, unknown>).reason ?? '')}`
          : '')
    );

    const embed = new EmbedBuilder()
      .setTitle(`Audit History — ${id}`)
      .setColor(0x5865f2)
      .setDescription(lines.join('\n').slice(0, 4000))
      .setFooter({ text: `Showing up to 30 entries for ${id}` });

    await message.reply({ embeds: [embed] }).catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// *premium-stats
// ---------------------------------------------------------------------------
export const premiumStatsCommand: PrefixCommand = {
  name: 'premium-stats',
  description: 'View premium statistics',
  adminOnly: true,
  requireGuild: false,
  async execute(message) {
    const entitlements = await entitlementService.listActiveEntitlements(1000);
    const serverCount = entitlements.filter((e) => e.premium_type === 'server').length;
    const userCount = entitlements.filter((e) => e.premium_type === 'user').length;

    const embed = new EmbedBuilder()
      .setTitle('Premium Statistics')
      .setColor(0x5865f2)
      .addFields(
        { name: 'Server Premium', value: `${serverCount}`, inline: true },
        { name: 'User Premium', value: `${userCount}`, inline: true },
        { name: 'Total active', value: `${entitlements.length}`, inline: true }
      )
      .setFooter({ text: 'Counts based on active entitlements only' });

    await message.reply({ embeds: [embed] }).catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// *premium-audit
// ---------------------------------------------------------------------------
export const premiumAuditCommand: PrefixCommand = {
  name: 'premium-audit',
  description: 'View recent bot-admin audit log',
  adminOnly: true,
  requireGuild: false,
  async execute(message) {
    const entries = await auditService.recent(30);
    if (entries.length === 0) {
      await message.reply('Audit log is empty.').catch(() => {});
      return;
    }

    const lines = entries.map(
      (e) =>
        `${formatTs(e.created_at)} — <@${e.actor_id}> — \`${e.action}\` — ${e.target_id ?? '—'}`
    );

    const embed = new EmbedBuilder()
      .setTitle('Recent Bot-Admin Actions')
      .setColor(0x5865f2)
      .setDescription(lines.join('\n').slice(0, 4000))
      .setFooter({ text: 'Showing last 30 entries' });

    await message.reply({ embeds: [embed] }).catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// Export the full set so index.ts can register in one array spread.
// ---------------------------------------------------------------------------
export const premiumAdminCommands: PrefixCommand[] = [
  spCommand,
  upCommand,
  revokeServerCommand,
  revokeUserCommand,
  inspectServerCommand,
  inspectUserCommand,
  premiumListCommand,
  premiumSearchCommand,
  premiumHistoryCommand,
  premiumStatsCommand,
  premiumAuditCommand,
];
