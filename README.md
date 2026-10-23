
**Notes on this README:**

- **Written for the actual deployment target.** Every reference is to Bot-Hosting.net, Bun, and the specific panel tabs (Startup, Environment). No Docker, no Railway, no Vercel. If a future-you reads this in six months, the steps are exactly what the platform needs.
- **Troubleshooting is ordered by likelihood, not category.** The most common failure (disabled Message Content intent) is #1 under "bot doesn't respond". The second-most (Supabase paused) is right there too. Each item is a decision tree, not a knowledge dump.
- **Command reference is exhaustive** — every command, every permission tier, in one scan-friendly section. Collapsible by header in rendered markdown.
- **"Adding a new command" gives a working code snippet.** The 3-step pattern (create file → import → spread) matches what files 13–24 already do. A future-you following the README produces code consistent with the existing codebase.
- **Security model is a summary, not a rehash.** One bullet per boundary; the detailed reasoning lives in code comments. The summary is what you paste when someone asks "is this bot secure?"
- **Redeploy checklist is 7 steps.** The whole point of this README is that future-you can redeploy from memory. If it takes more than a scroll to remember, it's too long.
- **File tree matches reality.** 30 files total (as promised), 12 command files, 3 event files (each bundling multiple handlers). Anyone auditing the code can match the tree against `git ls-files` exactly.

---

## Summary — what you have now

**All 30 files delivered.** Recapping the build:

| # | File | Purpose |
|---|---|---|
| 1 | `package.json` | Bun scripts, no dotenv/ts-node |
| 2 | `tsconfig.json` | `noEmit`, bun-types, strict |
| 3 | `.gitignore` | Keeps `bun.lockb`, ignores `.env` |
| 4 | `.env.example` | Five vars, all documented |
| 5 | `src/config.ts` | Fail-fast validation |
| 6 | `src/utils/logger.ts` | Colored console, no deps |
| 7 | `src/db/supabase.ts` | Service-role client + boot check |
| 8 | `src/services/permissionService.ts` | Bot admin + guild admin checks |
| 9 | `src/services/entitlementService.ts` | Single source of premium truth |
| 10 | `src/services/auditService.ts` | Append-only audit trail |
| 11 | `src/services/ticketService.ts` | Create/close/claim + transcripts |
| 12 | `src/bot/commandHandler.ts` | 5-gate prefix command middleware |
| 13 | `src/bot/commands/help.ts` | `*help` + `/help`, admin commands hidden |
| 14 | `src/bot/commands/ping.ts` | Gateway/REST/Supabase latency |
| 15 | `src/bot/commands/premium.ts` | User-facing premium status |
| 16 | `src/bot/commands/premiumAdmin.ts` | 11 admin commands |
| 17 | `src/bot/commands/premiumCustomize.ts` | 6 premium customization commands |
| 18 | `src/bot/commands/ticket.ts` | 8 ticket commands + panel |
| 19 | `src/bot/commands/welcome.ts` | 5 welcome commands |
| 20 | `src/bot/commands/logging.ts` | 4 logging commands + `sendGuildLog` |
| 21 | `src/bot/commands/moderation.ts` | 9 mod commands |
| 22 | `src/bot/commands/leveling.ts` | 7 leveling commands + XP award |
| 23 | `src/bot/commands/giveaway.ts` | 5 giveaway commands + poll loop |
| 24 | `src/bot/commands/config.ts` | 4 config commands |
| 25 | `src/bot/events/messageCreate.ts` | Create/delete/edit handlers |
| 26 | `src/bot/events/guildMemberAdd.ts` | Member/guild lifecycle handlers |
| 27 | `src/bot/events/interactionCreate.ts` | Ticket button + `/help` |
| 28 | `src/bot/index.ts` | Boot, wire, shutdown |
| 29 | `supabase/migrations/001_initial.sql` | Schema + RLS + storage |
| 30 | `README.md` | Deployment + reference |

**What to do next:**

1. Create the folder structure above.
2. Paste each file into its path.
3. `bun install` locally to generate `bun.lockb`.
4. Commit everything **except** `.env` to GitHub.
5. Run the SQL migration in Supabase.
6. Deploy to Bot-Hosting.net as Bun, set the five env vars in the panel.
7. Seed yourself in `bot_admins`.
8. Watch for the 9-line boot sequence, then run `*ping`.

If anything breaks during setup, the **Troubleshooting** section in the README covers the four failure modes that account for ~90% of "it won't start" scenarios: missing env var, disabled Message Content intent, paused Supabase project, and missing `bot_admins` seed.
