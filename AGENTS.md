# Hablia CRM Chatwoot — Shared Agent Instructions

## Scope and precedence

These rules apply to the entire Hablia Chatwoot fork. A more specific
`AGENTS.md` may add local constraints, but it must not weaken the security,
validation, enterprise-compatibility, or delivery requirements in this file.
`CLAUDE.md` is only a discovery adapter; this file is the canonical source for
shared Claude and Codex behavior.

## Repository purpose and boundaries

This repository is Hablia's maintained fork of Chatwoot, an omnichannel support
platform. It contains the Rails API and jobs, the Vue dashboard and widget, and
the Enterprise overlay.

- Keep migration-only work separate from product behavior and upstream syncs.
- Prefer the smallest change that preserves the fork's existing contracts.
- Check both `app/` and `enterprise/` before changing shared runtime behavior.
- Keep public APIs, webhooks, channel integrations, background jobs, and
  request/response contracts backward compatible unless the issue says otherwise.
- Use repository feature flags and the Hablia rollout policy for new or changed
  product behavior. Do not add a functional flag for documentation/tooling-only
  migrations.

The main stack is Ruby 3.4.4, Rails 7.1, PostgreSQL, Redis/Sidekiq, Node 24,
pnpm 10, Vue 3, Vite, Vitest, Tailwind, RSpec, RuboCop, and ESLint. See
`docs/ai/chatwoot-development-reference.md` for directories, local services,
seed workflows, and the validation matrix.

## Working agreement

1. Read the Linear issue, move it to `In Progress`, and assign it before editing.
2. Normal work branches from updated `develop`; use the exact Linear branch
   name in an isolated worktree. Hotfixes follow the workspace Git Flow rules.
3. Keep one issue per branch and preserve unrelated user changes.
4. Read the complete implementation, tests, routes, jobs, and Enterprise overlay
   related to a runtime change before editing.
5. Run the relevant validations below and attach evidence to the PR.
6. Run the portable pre-review before push or PR, applying
   `REVIEW_GUIDELINES.md` as the repository review contract.
7. Do not commit, push, open or merge a PR, deploy, or write to production
   without explicit user approval.

## Setup, development, and validation

Initialize `rbenv` before Ruby commands and use the versions pinned by
`.ruby-version` and `package.json`.

```bash
eval "$(rbenv init -)"
bundle install
pnpm install --frozen-lockfile
pnpm dev
```

Always prefer `bundle exec` for Ruby CLIs. `make setup` is the repository
shortcut for dependency installation. The standard development process may
also be started with `overmind start -f Procfile.dev`.

| Gate | Command | Required when |
|---|---|---|
| Ruby lint | `bundle exec rubocop --parallel` | Every Ruby change |
| JS/Vue lint | `pnpm eslint` | Every JS/Vue change |
| Ruby tests | `bundle exec rspec spec/path/to/file_spec.rb` | Every affected Ruby behavior |
| JS/Vue tests | `pnpm test` | Every affected frontend behavior |
| Production asset build | `RAILS_ENV=production bundle exec rake assets:precompile` | Build/config/asset changes, with non-secret CI-equivalent env |
| Dependency security | `bundle exec bundle-audit check --update` | Dependency or release-sensitive changes |
| AI parity | `node scripts/ai/check-client-parity.mjs` | Instructions, adapters, hooks, MCP, or AI tooling |
| AI parity fixtures | `node scripts/ai/test_client_parity.mjs` | Changes to the parity validator |
| Pre-review gate fixtures | `python3 scripts/ai/test_pre_review_gate.py` | Changes to pre-review tooling |

Use `pnpm test:watch` only for iteration. A single RSpec example can be run as
`bundle exec rspec spec/path/to/file_spec.rb:LINE_NUMBER`.

## Code and test conventions

- Ruby follows RuboCop and the configured 150-character limit. Use compact
  module/class definitions rather than unnecessary nesting.
- Vue components use PascalCase, emitted events use camelCase, and new Vue code
  uses the Composition API with `<script setup>` at the top.
- Use strong parameters at Rails boundaries and the repository's existing type
  contracts in frontend code.
- Validate model presence/uniqueness requirements and add indexes for new query
  contracts.
- Raise domain-specific exceptions from `lib/custom_exceptions/` where the
  existing pattern applies.
- Prefer `with_modified_env` over stubbing `ENV` directly in specs.
- In parallel or reload-sensitive specs, compare `error.class.name` when
  constant identity may legitimately differ.
- Keep changes minimal and readable. Avoid speculative abstractions, redundant
  guards, dead code, backup implementations, or tests unrelated to the issue.
- Behavior changes require targeted regression coverage; tooling-only changes
  require their deterministic tooling tests.

## Frontend, styling, and translations

- Use Tailwind utility classes. Do not add custom, scoped, or inline CSS unless
  an existing subsystem explicitly requires it.
- Use colors from `tailwind.config.js`.
- Do not place bare user-facing strings in templates; use i18n.
- Update only English source translations: backend `en.yml`, frontend
  `en.json`. Community translation files are not edited directly.
- Use `components-next/` for message bubbles; the legacy surface is deprecated.
- For white-label UI strings, use `replaceInstallationName` from
  `shared/composables/useBranding` instead of hardcoding Chatwoot or Hablia.

## Enterprise overlay

Any core or public API change must be checked against `enterprise/`.

- Search matching controllers, services, models, policies, routes, and specs in
  both trees before editing.
- Prefer extension points such as `prepend_mod_with` or `include_mod_with`
  for Enterprise-only behavior instead of hard-forking OSS code.
- Keep routes and response contracts aligned. Add mirrored Enterprise specs
  under `spec/enterprise` when the behavior differs there.
- Do not hardcode instance- or plan-specific behavior in OSS code.

## Seeds and local worktrees

- `bundle exec rails db:seed` creates the minimal local data set.
- `bundle exec rails search:setup_test_data` creates bulk search/load fixtures.
- Rich account fixtures use `Seeders::AccountSeeder` through Super Admin or
  `Internal::SeedAccountJob`; details are in the development reference.
- Each worktree must use isolated database names, Rails/Vite ports, Redis DB
  indexes, and Overmind sockets. Local generated settings remain ignored.

## Security and external systems

- Never commit or print credentials, OAuth tokens, cookies, service-account
  files, encryption keys, customer content, PII, signed URLs, or secret values.
- Treat PostgreSQL, Redis, email, social/messaging channels, storage, webhooks,
  Captain/LLM providers, and external ticketing as side-effecting systems.
- Diagnose read-only first. Verify account, workspace, project, and environment
  before external writes.
- Production, destructive operations, sends, deploys, data migrations,
  financial actions, and paid generation require explicit confirmation.
- Use fictional fixtures; never paste manually sanitized production data.

## Linear routing

The expected workspace is Hablia, with `HAB-` issues and team `Hablia-ai`.
Before the first Linear write in a session, verify the workspace read-only. If a
native integration resolves elsewhere, stop using it and select the
project-scoped `linear-hablia` connector declared in `.mcp.json` and
`.codex/config.toml`. Never create or update Hablia work in another workspace.

## Git and delivery

- Use Conventional Commits and include the issue in the description, for
  example `chore(crm): migrate agent compatibility (HAB-526)`.
- Do not mention an AI client in commit messages unless the client itself is
  the product scope of the issue.
- PR descriptions start with the user-facing outcome, link the issue, and
  include product-oriented testing/reproduction steps plus required evidence.
- Do not add a command dump titled “How this was tested”; put machine evidence
  in the repository's expected PR evidence section.
- The ignored `.agents/.pre-review-passed` marker must match the current diff
  before a feature-branch push or PR creation.

## Claude and Codex compatibility

- Shared behavior lives in this file and neutral resources under `.agents/`
  and `scripts/ai/`.
- `CLAUDE.md`, `.claude/`, `.codex/`, and `.mcp.json` are discovery or
  configuration adapters only. They must not redefine shared policy.
- `CLAUDE.md` must remain a regular file that imports `@AGENTS.md`; do not
  restore the historical symlink.
- This repository currently has no local skills, specialized agents, plugins,
  or slash commands. Add one only with a portable core, adapters for both
  supported clients, drift validation, and an approved `AIC-EXC-NNN` entry
  when safe equivalence is impossible.
- Run the parity checker whenever an instruction, adapter, hook, MCP declaration,
  manifest, or exception changes.
