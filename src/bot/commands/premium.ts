import { EmbedBuilder, GuildMember } from 'discord.js';
import { PrefixCommand } from '../commandHandler';
import { entitlementService } from '../../services/entitlementService';

const COLOR_ACTIVE = 0x57f287; // green
const COLOR_INACTIVE = 0x99aab5; // gray

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const ts = Math.floor(new Date(iso).getTime() / 1000);
  return `<t:${ts}:f>`; // Discord renders this in the viewer's locale
}

export const premiumCommand: PrefixCommand = {
  name: 'premium',
  description: 'Show premium status for this server and yourself',
  async execute(message) {
    if (!message.guild || !message.member) return;

    const guildId = message.guild.id;
    const userId = message.author.id;
    const member: GuildMember = message.member;

    // Fetch all three premium facts in parallel.
    const [serverEntitlement, userEntitlement, userUnlocksGuild] = await Promise.all([
      entitlementService.getActiveEntitlement('server', guildId),
      entitlementService.getActiveEntitlement('user', userId),
      entitlementService.userPremiumUnlocksGuild(member),
    ]);

    const serverActive = serverEntitlement !== null;
    const userActive = userEntitlement !== null;

    const embed = new EmbedBuilder()
      .setTitle('Premium Status')
      .setColor(serverActive || userActive ? COLOR_ACTIVE : COLOR_INACTIVE)
      .addFields(
        {
          name: 'Server Premium',
          value: serverActive
            ? `✅ Active — granted ${formatDate(serverEntitlement!.granted_at)}`
            : '❌ Not active',
          inline: false,
        },
        {
          name: 'Your User Premium',
          value: userActive
            ? `✅ Active — granted ${formatDate(userEntitlement!.granted_at)}`
            : '❌ Not active',
          inline: false,
        },
        {
          name: 'Your User Premium in this server',
          value: userActive
            ? userUnlocksGuild
              ? '✅ Unlocks premium here (you have Administrator)'
              : '⚠️ Entitlement active, but you lack Administrator in this server'
            : '❌ No User Premium entitlement to apply',
          inline: false,
        }
      );

    // Only show purchase info when the caller has nothing at all.
    if (!serverActive && !userActive) {
      embed.setDescription(
        'This server does not have Server Premium, and you do not have User Premium.\n' +
          'Server Premium unlocks features for the whole server. User Premium unlocks them ' +
          'in any server where you have Administrator.'
      );
    }

    embed.setFooter({ text: 'Premium is permanent and bound to the server or user it was granted to.' });

    await message.reply({ embeds: [embed] });
  },
};
