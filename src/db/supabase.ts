import { createClient } from '@supabase/supabase-js';
import { config } from '../config';
import { logger } from '../utils/logger';

export const supabase = createClient(
  config.supabase.url,
  config.supabase.serviceRoleKey,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: {
        'x-application-name': 'discord-bot',
      },
    },
  }
);

// One-time connectivity check at boot. Fails fast if the URL or key is wrong,
// rather than silently failing on the first command hours later.
export async function verifySupabaseConnection(): Promise<void> {
  const { error } = await supabase
    .from('bot_admins')
    .select('discord_user_id', { count: 'exact', head: true })
    .limit(1);

  if (error) {
    logger.error('[Supabase] Connection check failed:', error.message);
    logger.error('Verify SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the panel.');
    logger.error('Also confirm 001_initial.sql has been run in the Supabase SQL editor.');
    process.exit(1);
  }

  logger.info('[Supabase] Connection verified.');
}
