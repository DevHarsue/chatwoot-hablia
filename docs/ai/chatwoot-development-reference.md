# Hablia Chatwoot development reference

This reference keeps detailed repository guidance outside the always-loaded
`AGENTS.md`. It is provider-neutral and applies equally to Claude and Codex.

## Architecture map

| Area | Primary paths | Notes |
|---|---|---|
| Rails application | `app/`, `config/`, `lib/` | APIs, models, jobs, services, mailers, channels |
| Vue dashboard/widget | `app/javascript/` | Vue 3, Vite, Tailwind, Pinia/Vuex, Vitest |
| Enterprise overlay | `enterprise/`, `spec/enterprise/` | Extensions and overrides of OSS behavior |
| Ruby tests | `spec/` | RSpec, factories, request/service/job/model coverage |
| Frontend tests | colocated `*.spec.*` files | Vitest and Vue Test Utils |
| Background work | Sidekiq jobs and Redis | Treat queues and scheduled work as side effects |
| Persistence/search | PostgreSQL, pgvector, OpenSearch when configured | Use local/test data only during validation |

Chatwoot integrates with email, website chat, WhatsApp, Instagram/Facebook,
Telegram, Line, SMS, storage, webhooks, and third-party support tooling. A
diagnostic command must not send messages or mutate an external service unless
the user has approved the exact target and action.

## Toolchain and commands

- Ruby: `3.4.4` from `.ruby-version`; initialize `rbenv` before Bundler.
- Rails: `7.1`.
- Node: `24.x`; pnpm: `10.x`, pinned in `package.json`.
- Setup: `make setup` or `bundle install && pnpm install --frozen-lockfile`.
- Development: `pnpm dev` or `overmind start -f Procfile.dev`.
- Ruby lint: `bundle exec rubocop --parallel`.
- Frontend lint: `pnpm eslint`; `pnpm eslint:fix` is mutating and should be
  used only when intentional.
- Ruby tests: `bundle exec rspec spec/path/to/file_spec.rb`.
- Frontend tests: `pnpm test`; watch mode is `pnpm test:watch`.
- Production-equivalent asset build:
  `RAILS_ENV=production bundle exec rake assets:precompile`, with only
  non-secret CI-equivalent environment values.

Do not run the full backend suite by default for a documentation-only change;
run the deterministic tooling tests plus lint/build gates affected by the diff.
For runtime changes, expand from targeted tests to the relevant CI shard.

## Local data

- `bundle exec rails db:seed` creates the normal minimal development data.
- `bundle exec rails search:setup_test_data` creates bulk data for search and
  performance exercises.
- Rich account data can be enqueued from Super Admin via **Accounts → Seed**,
  which invokes `Internal::SeedAccountJob`.
- The equivalent local CLI is:

  ```bash
  bundle exec rails runner "Internal::SeedAccountJob.perform_now(Account.find(<id>))"
  ```

  `Seeders::AccountSeeder.new(account: Account.find(<id>)).perform!` is the
  lower-level alternative.

Never run seeders against production or a shared database without explicit
approval and target verification.

## Enterprise compatibility checklist

For core logic or public API changes:

1. Search the related constant, controller, service, policy, model, and route in
   both `app/` and `enterprise/`.
2. Check whether Enterprise needs an override or an extension point.
3. Keep the OSS response/request contract stable.
4. Mirror renamed or moved shared code where the overlay depends on its path.
5. Add Enterprise-specific specs under `spec/enterprise/` when applicable.

The upstream Enterprise practices are documented at
<https://chatwoot.help/hc/handbook/articles/developing-enterprise-edition-features-38>.

## Worktree isolation

Use one branch and worktree per issue. Generated local configuration may create
per-worktree database names, Rails and Vite ports, Redis DB indexes, and
Overmind socket/title values. Keep those values in ignored local files; never
commit machine-specific paths or ports.

## AI client surface

The repository's supported AI-development surface is intentionally small:

| Resource | Canonical source | Claude adapter | Codex adapter |
|---|---|---|---|
| Repository instructions | `AGENTS.md` | `CLAUDE.md` imports the source | Direct `AGENTS.md` discovery |
| Linear routing policy | `.agents/mcp/linear-hablia.md` | `.mcp.json` | `.codex/config.toml` |
| Pre-review gate | `scripts/ai/pre_review_gate.py` | compatibility wrapper + hook registration | direct hook registration |

There are no repository-local skills, specialized agents, plugins, or slash
commands in the migrated baseline. That absence is deliberate, not an
invitation to create empty directories.

The historical `CLAUDE.md -> AGENTS.md` symlink was replaced by a regular
import adapter because a symlink was not validated as the only discovery
mechanism on Windows. The parity checker verifies file type, import, hashes,
adapter coverage, exception metadata, and common secret indicators without
making network calls.

`REVIEW_GUIDELINES.md` is the client-neutral review contract for the portable
pre-review. It defines severity, non-negotiable safety rules, validation
expectations, and the review output format used before push or PR.

## Representative parity evidence

Run from the repository root:

```bash
node scripts/ai/check-client-parity.mjs
node scripts/ai/test_client_parity.mjs
python3 scripts/ai/test_pre_review_gate.py
```

The representative Claude path resolves `CLAUDE.md` and imports
`AGENTS.md`. The representative Codex path consumes `AGENTS.md` directly.
Both must resolve the same Linear routing and pre-review policy, and neither
validation command may perform an external write.
