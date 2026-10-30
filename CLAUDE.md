# CLAUDE.md

Context for Claude Code (and humans) working in this repo.

## What this is

**Lead Engine** (working name): a WhatsApp AI front desk + staff CRM that connects ads, AI and sales for local businesses, sold through marketing agencies. Live pilot: Goldkraft Fitness (GKF), Bengaluru. One Node 24 / Express app serves the bot (`wa.*` host) and the CRM (`crm.*` host) on one Postgres database, hosted on Heroku (`gkf-wa`).

Read before larger changes: `docs/ARCHITECTURE.md`, `docs/PRODUCT_PLAN.md`, `docs/META_PLATFORM.md`, `docs/TEAM.md` (owners and task IDs).

## Commands

- `npm ci`: install
- `npm run dev`: bot on http://localhost:3000, CRM on http://crm.localhost:3000 (PGlite in `./data/pglite`, no services needed)
- `npm run dev:demo-data`: sample leads (stop the dev server first; PGlite allows one process)
- `npm test`: all tests (bot `test/`, CRM `test/crm/`) on in-memory PGlite with fake Meta/OpenRouter
- `npm run migrate`: apply migrations

## Rules

- Work on a branch and open a PR; never push to `main`. CI runs `npm test`.
- Owners: Kaamil owns `src/`, `scripts/`, infra and Meta; Krishna owns `crm/` and `test/crm/`. Cross-area changes need an agreed contract (see `docs/TEAM.md`).
- Never commit or print secrets (tokens, keys, passwords). `.env` is git-ignored; `.env.example` lists the variables.
- Tests must never call Meta, OpenRouter or Telegram. Use the existing fakes (`aiService.transport`, `whatsappService.transport`, `notifyService.sendOverride`).
- Don't run paid AI calls (`scripts/eval.js`, ad-hoc OpenRouter requests) without the user's OK. Keep AI to one call per reply.
- Migrations are append-only (`src/db/schema.js`, `crm/src/migrations.js`); never edit one that already ran.
- Don't deploy to Heroku or change production config unless the user explicitly asks.
- The bot must stay business-scoped (Meta bans general-purpose AI assistants) and must never invent facts beyond the business profile.
- Bot replies: simple Indian English (or the lead's language), no em dashes, no markdown, at most one question and only when it qualifies the lead.
- `leads.wa_id` is the lead key: a phone number or Meta's business-scoped user ID (e.g. `IN.1234...`) for users who hide their phone. Never assume it's digits; use `leads.phone` (may be null), `src/services/identity.js` and the CRM's `util.contactLabel` / `util.leadPhone`.
- Update the relevant doc in `docs/` in the same PR when behaviour changes.
