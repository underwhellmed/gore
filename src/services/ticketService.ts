import {
  ChannelType,
  Guild,
  GuildMember,
  PermissionFlagsBits,
  TextChannel,
} from 'discord.js';
import { createTranscript } from 'discord-html-transcripts';
import { supabase } from '../db/supabase';
import { logger } from '../utils/logger';

export interface Ticket {
  ticket_id: string;
  guild_id: string;
  channel_id: string;
  owner_id: string;
  status: 'open' | 'closed' | 'archived';
  category: string | null;
  claimed_by: string | null;
  created_at: string;
  closed_at: string | null;
  transcript_url: string | null;
}

export class TicketService {
  /**
   * Create a private ticket channel for a user, insert the ticket row,
   * and return the channel. If channel creation succeeds but the DB insert
   * fails, the channel is deleted to avoid an orphan.
   */
  async createTicket(
    guild: Guild,
    member: GuildMember,
    categoryId: string,
    staffRoleId: string
  ): Promise<TextChannel> {
    // Reject if the user already has an open ticket in this guild.
    const { data: existing, error: existingError } = await supabase
      .from('tickets')
      .select('ticket_id')
      .eq('guild_id', guild.id)
      .eq('owner_id', member.id)
      .eq('status', 'open')
      .maybeSingle();

    if (existingError) throw new Error('Could not check existing tickets.');
    if (existing) throw new Error('You already have an open ticket.');

    // Sanitize the channel name. Discord channel names allow a-z, 0-9, dashes.
    const safeName = member.user.username
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '')
      .slice(0, 20) || 'user';
    const channelName = `ticket-${safeName}`;

    const channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: categoryId,
      topic: `Ticket owner: ${member.id}`,
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          deny: [PermissionFlagsBits.ViewChannel],
        },
        {
          id: member.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
          ],
        },
        {
          id: staffRoleId,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.AttachFiles,
          ],
        },
        {
          id: guild.members.me!.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
          ],
        },
      ],
    });

    const { error: insertError } = await supabase.from('tickets').insert({
      guild_id: guild.id,
      channel_id: channel.id,
      owner_id: member.id,
      status: 'open',
    });

    if (insertError) {
      logger.error('[TicketService] DB insert failed, deleting orphan channel:', insertError.message);
      await channel.delete().catch(() => {});
      throw new Error('Failed to register ticket. Please try again.');
    }

    logger.info(`[TicketService] Created ticket ${channel.id} for ${member.id} in ${guild.id}`);
    return channel;
  }

  /**
   * Close a ticket: generate an HTML transcript, upload it to Supabase
   * Storage, mark the ticket row as closed, post a copy to the log
   * channel, then delete the channel.
   *
   * Ordering matters: the transcript must exist before the channel is
   * deleted, or the messages are lost forever.
   */
  async closeTicket(
    channel: TextChannel,
    closedBy: GuildMember,
    logChannelId?: string
  ): Promise<void> {
    const ticket = await this.getOpenTicketByChannel(channel.id);
    if (!ticket) throw new Error('This is not an open ticket.');

    // 1. Generate transcript.
    const transcript = await createTranscript(channel, {
      limit: -1,
      returnType: 'buffer',
      filename: `ticket-${channel.id}.html`,
      saveImages: false,
    });

    // 2. Upload to Supabase Storage. Bucket "transcripts" must exist and
    //    be private. Path: tickets/<guildId>/<channelId>.html
    const storagePath = `tickets/${channel.guild.id}/${channel.id}.html`;
    const { error: uploadError } = await supabase.storage
      .from('transcripts')
      .upload(storagePath, transcript, {
        contentType: 'text/html',
        upsert: true,
      });

    if (uploadError) {
      logger.error('[TicketService] Transcript upload failed:', uploadError.message);
      throw new Error('Failed to upload transcript. Ticket was not closed.');
    }

    // 3. Update the ticket row. If this fails, the channel still exists
    //    and the transcript is in storage — better than losing the channel.
    const { error: updateError } = await supabase
      .from('tickets')
      .update({
        status: 'closed',
        closed_at: new Date().toISOString(),
        transcript_url: storagePath,
      })
      .eq('ticket_id', ticket.ticket_id);

    if (updateError) {
      logger.error('[TicketService] Ticket update failed:', updateError.message);
      throw new Error('Transcript saved but ticket record update failed.');
    }

    // 4. Post a copy to the log channel (best effort — never blocks close).
    if (logChannelId) {
      await this.postTranscriptToLog(channel, transcript, closedBy, logChannelId).catch(
        (err) => logger.error('[TicketService] Log channel post failed:', err?.message ?? err)
      );
    }

    // 5. Delete the channel.
    try {
      await channel.delete(`Closed by ${closedBy.user.tag}`);
    } catch (err: any) {
      logger.error('[TicketService] Channel delete failed:', err?.message ?? err);
      throw new Error('Ticket closed but channel could not be deleted.');
    }

    logger.info(`[TicketService] Closed ticket ${ticket.ticket_id} (${channel.id}) by ${closedBy.id}`);
  }

  /**
   * Claim a ticket: assign the staff member as the claimant.
   * Returns true if the claim was set, false if the ticket is already claimed.
   */
  async claimTicket(channelId: string, staff: GuildMember): Promise<boolean> {
    const ticket = await this.getOpenTicketByChannel(channelId);
    if (!ticket) throw new Error('This is not an open ticket.');
    if (ticket.claimed_by) return false;

    const { error } = await supabase
      .from('tickets')
      .update({ claimed_by: staff.id })
      .eq('ticket_id', ticket.ticket_id)
      .is('claimed_by', null);

    if (error) {
      logger.error('[TicketService] Claim update failed:', error.message);
      return false;
    }
    return true;
  }

  async getOpenTicketByChannel(channelId: string): Promise<Ticket | null> {
    const { data, error } = await supabase
      .from('tickets')
      .select('*')
      .eq('channel_id', channelId)
      .eq('status', 'open')
      .maybeSingle();

    if (error) {
      logger.error('[TicketService] getOpenTicketByChannel failed:', error.message);
      return null;
    }
    return data as Ticket | null;
  }

  /**
   * Generate a signed download URL for a transcript. Only used by bot admins
   * or server admins in future commands — private bucket means no direct URL
   * is ever shareable without going through this method.
   */
  async getTranscriptSignedUrl(storagePath: string, expiresInSeconds = 3600): Promise<string | null> {
    const { data, error } = await supabase.storage
      .from('transcripts')
      .createSignedUrl(storagePath, expiresInSeconds);

    if (error) {
      logger.error('[TicketService] Signed URL generation failed:', error.message);
      return null;
    }
    return data?.signedUrl ?? null;
  }

  private async postTranscriptToLog(
    channel: TextChannel,
    transcript: Buffer,
    closedBy: GuildMember,
    logChannelId: string
  ): Promise<void> {
    const logChannel = await channel.guild.channels.fetch(logChannelId).catch(() => null);
    if (!logChannel || !logChannel.isTextBased()) {
      logger.warn(`[TicketService] Log channel ${logChannelId} not found or not text-based.`);
      return;
    }

    await (logChannel as TextChannel).send({
      content: `🎫 Ticket \`${channel.name}\` closed by <@${closedBy.id}>`,
      files: [{ attachment: transcript, name: `ticket-${channel.id}.html` }],
    });
  }
}

export const ticketService = new TicketService();
