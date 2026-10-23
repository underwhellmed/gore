// Bun automatically loads .env files — no dotenv import needed.

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    console.error(`[FATAL] Missing required environment variable: ${name}`);
    console.error('Set this in Bot-Hosting panel → Startup → Environment.');
    console.error('See .env.example for the full list of required variables.');
    process.exit(1);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== '' ? value : fallback;
}

export const config = {
  discord: {
    token: required('DISCORD_TOKEN'),
    clientId: required('DISCORD_CLIENT_ID'),
  },
  supabase: {
    url: required('SUPABASE_URL'),
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  },
  prefix: optional('PREFIX', '*'),
} as const;
