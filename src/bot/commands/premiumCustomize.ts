import { EmbedBuilder, Message } from 'discord.js';
import { PrefixCommand } from '../commandHandler';
import { supabase } from '../../db/supabase';
import { entitlementService } from '../../services/entitlementService';
import { logger } from '../../utils/logger';

interface Customization {
  guild_id: string;
  bot_avatar_url: string | null;
  bot_banner_url: string | null;
  bot_bio: string | null;
  custom_embeds: {
    color?: string;
    footer?: string;
    thumbnail?: string;
  } | null;
  custom_presence: unknown;
}

const HEX_RE = /^#?[0-9a-fA-F]{6}$/;
const URL_RE = /^https?:\/\/\S+$/;

async function requireServerPremium(message: Message): Promise<boolean> {
  if (!message.guild) return false;
  const active = await entitlementService.hasServerPremium(message.guild.id);
  if (!active) {
    await message
      .reply('This command requires **Server Premium** for this server. Run `*premium` for details.')
      .catch(() => {});
    return false;
  }
  return true;
}

async function getCustomization(guildId: string): Promise<Customization | null> {
  const { data, error } = await supabase
    .from('premium_customizations')
    .select('*')
    .eq('guild_id', guildId)
    .maybeSingle();
  if (error) {
    logger.error('[premiumCustomize] read failed:', error.message);
    return null;
  }
  return (data as Customization | null) ?? null;
}

async function upsertCustomEmbeds(
  guildId: string,
  patch: Partial<NonNullable<Customization['custom_embeds']>>
): Promise<void> {
  const existing = await getCustomization(guildId);
  const currentEmbeds = existing?.custom_embeds ?? {};
  const mergedEmbeds = { ...currentEmbeds, ...patch };

  const { error } = await supabase.from('premium_customizations').upsert({
    guild_id: guildId,
    custom_embeds: mergedEmbeds,
  });

  if (error) {
    logger.error('[premiumCustomize] upsert failed:', error.message);
    throw new Error('Failed to save customization.');
  }
}

// ---------------------------------------------------------------------------
// *premium-color <hex>
// ---------------------------------------------------------------------------
export const premiumColorCommand: PrefixCommand = {
  name: 'premium-color',
  description: 'Set the embed accent color for this server (premium)',
  guildAdminOnly: true,
  async execute(message, args) {
    if (!message.guild) return;
    if (!(await requireServerPremium(message))) return;

    const raw = args[0];
    if (!raw || !HEX_RE.test(raw)) {
      return message.reply('Usage: `*premium-color <#RRGGBB>` (e.g. `*premium-color #5865f2`)').catch(() => {});
    }
    const normalized = raw.startsWith('#') ? raw : `#${raw}`;

    try {
      await upsertCustomEmbeds(message.guild.id, { color: normalized });
    } catch (err: any) {
      return message.reply(`❌ ${err.message}`).catch(() => {});
    }

    await message.reply(`✅ Embed color set to \`${normalized}\`.`).catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// *premium-footer <text>   |  *premium-footer clear
// ---------------------------------------------------------------------------
export const premiumFooterCommand: PrefixCommand = {
  name: 'premium-footer',
  description: 'Set the embed footer text for this server (premium)',
  guildAdminOnly: true,
  async execute(message, args) {
    if (!message.guild) return;
    if (!(await requireServerPremium(message))) return;

    const text = args.join(' ').trim();
    if (!text) {
      return message.reply('Usage: `*premium-footer <text>` or `*premium-footer clear`').catch(() => {});
    }

    if (text.toLowerCase() === 'clear') {
      await upsertCustomEmbeds(message.guild.id, { footer: undefined }).catch(() => {});
      return message.reply('✅ Footer cleared.').catch(() => {});
    }

    if (text.length > 200) {
      return message.reply('❌ Footer text must be 200 characters or fewer.').catch(() => {});
    }

    try {
      await upsertCustomEmbeds(message.guild.id, { footer: text });
    } catch (err: any) {
      return message.reply(`❌ ${err.message}`).catch(() => {});
    }

    await message.reply(`✅ Footer set to: **${text}**`).catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// *premium-thumbnail <url>  |  *premium-thumbnail clear
// ---------------------------------------------------------------------------
export const premiumThumbnailCommand: PrefixCommand = {
  name: 'premium-thumbnail',
  description: 'Set the embed thumbnail URL for this server (premium)',
  guildAdminOnly: true,
  async execute(message, args) {
    if (!message.guild) return;
    if (!(await requireServerPremium(message))) return;

    const raw = args[0];
    if (!raw) {
      return message.reply('Usage: `*premium-thumbnail <url>` or `*premium-thumbnail clear`').catch(() => {});
    }

    if (raw.toLowerCase() === 'clear') {
      await upsertCustomEmbeds(message.guild.id, { thumbnail: undefined }).catch(() => {});
      return message.reply('✅ Thumbnail cleared.').catch(() => {});
    }

    if (!URL_RE.test(raw)) {
      return message.reply('❌ Provide a full `http(s)://` URL.').catch(() => {});
    }

    try {
      await upsertCustomEmbeds(message.guild.id, { thumbnail: raw });
    } catch (err: any) {
      return message.reply(`❌ ${err.message}`).catch(() => {});
    }

    await message.reply('✅ Thumbnail URL set.').catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// *premium-about <text>  |  *premium-about clear
// Shown in *help for this server. Stored in bot_bio column.
// ---------------------------------------------------------------------------
export const premiumAboutCommand: PrefixCommand = {
  name: 'premium-about',
  description: 'Set a per-server about line shown in *help (premium)',
  guildAdminOnly: true,
  async execute(message, args) {
    if (!message.guild) return;
    if (!(await requireServerPremium(message))) return;

    const text = args.join(' ').trim();
    if (!text) {
      return message.reply('Usage: `*premium-about <text>` or `*premium-about clear`').catch(() => {});
    }

    if (text.toLowerCase() === 'clear') {
      const { error } = await supabase
        .from('premium_customizations')
        .upsert({ guild_id: message.guild.id, bot_bio: null });
      if (error) return message.reply('❌ Failed to clear.').catch(() => {});
      return message.reply('✅ About line cleared.').catch(() => {});
    }

    if (text.length > 500) {
      return message.reply('❌ About text must be 500 characters or fewer.').catch(() => {});
    }

    const { error } = await supabase
      .from('premium_customizations')
      .upsert({ guild_id: message.guild.id, bot_bio: text });

    if (error) {
      logger.error('[premiumCustomize] about upsert failed:', error.message);
      return message.reply('❌ Failed to save.').catch(() => {});
    }

    await message.reply('✅ About line set. It will appear in `*help`.').catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// *premium-customize  — view current customizations
// ---------------------------------------------------------------------------
export const premiumCustomizeViewCommand: PrefixCommand = {
  name: 'premium-customize',
  description: 'View premium customizations for this server',
  guildAdminOnly: true,
  async execute(message) {
    if (!message.guild) return;
    if (!(await requireServerPremium(message))) return;

    const cust = await getCustomization(message.guild.id);
    const embeds = cust?.custom_embeds ?? {};

    const embed = new EmbedBuilder()
      .setTitle('Premium Customizations')
      .setColor(embeds.color ? parseInt(embeds.color.replace('#', ''), 16) : 0x5865f2)
      .addFields(
        { name: 'Embed color', value: embeds.color ?? '— (default)', inline: true },
        { name: 'Footer', value: embeds.footer ?? '—', inline: false },
        { name: 'Thumbnail', value: embeds.thumbnail ? `[link](${embeds.thumbnail})` : '—', inline: false },
        { name: 'About line', value: cust?.bot_bio ?? '—', inline: false }
      )
      .setFooter({ text: 'Manage: *premium-color, *premium-footer, *premium-thumbnail, *premium-about' });

    await message.reply({ embeds: [embed] }).catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// *premium-reset — clear all customizations for this server
// ---------------------------------------------------------------------------
export const premiumResetCommand: PrefixCommand = {
  name: 'premium-reset',
  description: 'Clear all premium customizations for this server',
  guildAdminOnly: true,
  async execute(message) {
    if (!message.guild) return;
    if (!(await requireServerPremium(message))) return;

    const { error } = await supabase
      .from('premium_customizations')
      .delete()
      .eq('guild_id', message.guild.id);

    if (error) {
      logger.error('[premiumCustomize] reset failed:', error.message);
      return message.reply('❌ Failed to reset.').catch(() => {});
    }

    await message.reply('✅ All premium customizations cleared.').catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// Bulk export
// ---------------------------------------------------------------------------
export const premiumCustomizeCommands: PrefixCommand[] = [
  premiumColorCommand,
  premiumFooterCommand,
  premiumThumbnailCommand,
  premiumAboutCommand,
  premiumCustomizeViewCommand,
  premiumResetCommand,
];
