#!/usr/bin/env node

/** Fixtures deterministas del validador de paridad Claude × Codex. */

import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const checker = path.join(scriptDir, 'check-client-parity.mjs');

function descriptor({ client, output }) {
  return `schema_version: 1
resource:
  type: "skill"
  name: "demo"
source: ".agents/skills/demo/SKILL.md"
client: "${client}"
outputs:
  - "${output}"
transformations: []
capability_mapping: {}
validation:
  commands:
    - "node scripts/ai/check-client-parity.mjs"
drift:
  strategy: "direct"
owner: "Francisco Maldonado"
exception_ids: []
`;
}

async function write(root, relativePath, content) {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

async function fixture(root) {
  await Promise.all([
    write(root, 'AGENTS.md', '# Reglas\n'),
    write(root, 'CLAUDE.md', '@AGENTS.md\n'),
    write(
      root,
      'REVIEW_GUIDELINES.md',
      `# Review\n\n## Severidades\n\n## NEVER\n\n## Validación y límites\n\n## Formato de salida\n\n## BLOCKING (n)\n\n## WARNINGS (n)\n\n## SUGGESTIONS (n)\n\n## Verdict\n`
    ),
    write(
      root,
      '.agents/skills/demo/SKILL.md',
      '---\nname: demo\ndescription: Fixture portable\n---\n\nValidar.\n'
    ),
    write(
      root,
      '.agents/adapters/skill/demo/claude.yaml',
      descriptor({ client: 'claude', output: '.claude/skills/demo/SKILL.md' })
    ),
    write(
      root,
      '.agents/adapters/skill/demo/codex.yaml',
      descriptor({ client: 'codex', output: '.agents/skills/demo/SKILL.md' })
    ),
    write(
      root,
      '.claude/skills/demo/SKILL.md',
      '---\nname: demo\ndescription: Fixture portable\n---\n\nValidar.\n'
    ),
    write(
      root,
      'docs/devops/ai-client-exceptions.yaml',
      'schema_version: 1\nexceptions: []\n'
    ),
  ]);
}

function run(root) {
  return spawnSync(process.execPath, [checker, '--repo', root], {
    encoding: 'utf8',
  });
}

function runWithArgs(...args) {
  return spawnSync(process.execPath, [checker, ...args], { encoding: 'utf8' });
}

function expectPass(result, label) {
  if (result.status !== 0)
    throw new Error(
      `${label}: debía pasar\n${result.stdout}\n${result.stderr}`
    );
}

function expectFailure(result, token, label) {
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.status === 0 || !output.includes(token)) {
    throw new Error(`${label}: debía fallar con ${token}\n${output}`);
  }
}

const root = await mkdtemp(path.join(os.tmpdir(), 'hablia-ai-parity-'));
try {
  await fixture(root);
  expectPass(run(root), 'fixture base');
  await rm(path.join(root, 'REVIEW_GUIDELINES.md'));
  expectFailure(
    run(root),
    'MISSING_REVIEW_GUIDELINES',
    'guía de pre-review ausente'
  );
  await write(
    root,
    'REVIEW_GUIDELINES.md',
    `# Review\n\n## Severidades\n\n## NEVER\n\n## Validación y límites\n\n## Formato de salida\n\n## BLOCKING (n)\n\n## WARNINGS (n)\n\n## SUGGESTIONS (n)\n\n## Verdict\n`
  );
  expectFailure(
    runWithArgs('--repo', root, 'argumento-suelto'),
    'Argumento no reconocido',
    'argumento posicional inválido'
  );

  await write(root, '.claude/commands/demo.md', '# Demo\n');
  await write(
    root,
    'docs/ai/workflows.md',
    '| Legacy Claude command | Portable intent | Codex request example |\n| --- | --- | --- |\n| `/demo` | Demo portable | `demo` |\n'
  );
  await write(
    root,
    'docs/devops/ai-client-exceptions.yaml',
    `schema_version: 1
exceptions:
  - id: "AIC-EXC-901"
    client: "claude"
    paths:
      - ".claude/commands"
    workflow_map: "docs/ai/workflows.md"
    reason: "Fixture de comandos exclusivos."
    owner: "Francisco Maldonado"
    approved_by:
      - "Francisco Maldonado"
    expires_on: "2099-01-01"
    validation:
      command: "node scripts/ai/check-client-parity.mjs"
`
  );
  expectFailure(
    run(root),
    'EXCEPTION_COMMAND_SCOPE',
    'excepción de comandos amplia'
  );

  await write(
    root,
    'docs/devops/ai-client-exceptions.yaml',
    `schema_version: 1
exceptions:
  - id: "AIC-EXC-901"
    client: "claude"
    paths:
      - ".claude"
    workflow_map: "docs/ai/workflows.md"
    reason: "Fixture de comandos exclusivos."
    owner: "Francisco Maldonado"
    approved_by:
      - "Francisco Maldonado"
    expires_on: "2099-01-01"
    validation:
      command: "node scripts/ai/check-client-parity.mjs"
`
  );
  expectFailure(
    run(root),
    'EXCEPTION_COMMAND_SCOPE',
    'excepción que cubre Claude completo'
  );

  await write(
    root,
    'docs/devops/ai-client-exceptions.yaml',
    `schema_version: 1
exceptions:
  - id: "AIC-EXC-901"
    client: "claude"
    paths:
      - ".claude/commands/demo.md"
    workflow_map: "docs/ai/workflows.md"
    reason: "Fixture de comandos exclusivos."
    owner: "Francisco Maldonado"
    approved_by:
      - "Francisco Maldonado"
    expires_on: "2099-01-01"
    validation:
      command: "node scripts/ai/check-client-parity.mjs"
`
  );
  expectPass(run(root), 'comando exclusivo con workflow portable');
  await write(
    root,
    'docs/ai/workflows.md',
    '| Legacy Claude command | Portable intent | Codex request example |\n| --- | --- | --- |\n'
  );
  expectFailure(
    run(root),
    'EXCEPTION_WORKFLOW',
    'comando exclusivo sin workflow portable'
  );
  await rm(path.join(root, '.claude', 'commands'), {
    recursive: true,
    force: true,
  });
  await write(
    root,
    'docs/devops/ai-client-exceptions.yaml',
    'schema_version: 1\nexceptions: []\n'
  );

  await write(
    root,
    '.agents/adapters/skill/demo/claude.yaml',
    descriptor({
      client: 'claude',
      output: '.claude/skills/demo/SKILL.md',
    }).replace('transformations: []\ncapability_mapping: {}\n', '')
  );
  expectFailure(
    run(root),
    'DESCRIPTOR_CONTRACT',
    'descriptor sin campos obligatorios'
  );
  await write(
    root,
    '.agents/adapters/skill/demo/claude.yaml',
    descriptor({ client: 'claude', output: '.claude/skills/demo/SKILL.md' })
  );

  await write(
    root,
    '.agents/adapters/skill/demo/claude.yaml',
    descriptor({
      client: 'claude',
      output: '.claude/skills/demo/SKILL.md',
    }).replace('transformations: []', 'transformations:\n  invalid: true')
  );
  expectFailure(
    run(root),
    'DESCRIPTOR_CONTRACT',
    'transformations con tipo mapa'
  );
  await write(
    root,
    '.agents/adapters/skill/demo/claude.yaml',
    descriptor({
      client: 'claude',
      output: '.claude/skills/demo/SKILL.md',
    }).replace('capability_mapping: {}', 'capability_mapping:\n  - invalid')
  );
  expectFailure(
    run(root),
    'DESCRIPTOR_CONTRACT',
    'capability_mapping con tipo lista'
  );
  await write(
    root,
    '.agents/adapters/skill/demo/claude.yaml',
    descriptor({ client: 'claude', output: '.claude/skills/demo/SKILL.md' })
  );

  await write(
    root,
    '.agents/adapters/skill/demo/claude.yaml',
    descriptor({
      client: 'claude',
      output: '.claude/skills/demo/SKILL.md',
    }).replace(
      'source: ".agents/skills/demo/SKILL.md"',
      'source: ".claude/skills/demo/SKILL.md"'
    )
  );
  expectFailure(run(root), 'CLIENT_AS_SOURCE', 'núcleo ubicado bajo cliente');
  await write(
    root,
    '.agents/adapters/skill/demo/claude.yaml',
    descriptor({ client: 'claude', output: '.claude/skills/demo/SKILL.md' })
  );

  await write(
    root,
    '.agents/adapters/skill/demo/claude.yaml',
    `schema_version: 1
resource:
  type: "skill"
  name: "demo"
source: ".agents/skills/demo/SKILL.md"
client: "claude"
outputs:
  - ".claude/skills/demo/"
  invalid: true
drift:
  strategy: "direct"
owner: "Francisco Maldonado"
exception_ids: []
`
  );
  expectFailure(run(root), 'INVALID_YAML', 'YAML con lista y mapa mezclados');
  await write(
    root,
    '.agents/adapters/skill/demo/claude.yaml',
    descriptor({ client: 'claude', output: '.claude/skills/demo/SKILL.md' })
  );

  await write(
    root,
    '.agents/adapters/skill/demo/claude.yaml',
    descriptor({
      client: 'claude',
      output: '.claude/skills/demo/SKILL.md',
    }).replace('owner: "Francisco Maldonado"', 'owner: "Francisco Maldonado')
  );
  expectFailure(run(root), 'INVALID_YAML', 'YAML con comillas sin cierre');
  await write(
    root,
    '.agents/adapters/skill/demo/claude.yaml',
    descriptor({ client: 'claude', output: '.claude/skills/demo/SKILL.md' })
  );

  await write(
    root,
    '.agents/adapters/skill/demo/claude.yaml',
    descriptor({
      client: 'claude',
      output: '.claude/skills/demo/SKILL.md',
    }).replace('owner: "Francisco Maldonado"', 'owner: "a" "b"')
  );
  expectFailure(run(root), 'INVALID_YAML', 'YAML con comillas ambiguas');
  await write(
    root,
    '.agents/adapters/skill/demo/claude.yaml',
    `${descriptor({ client: 'claude', output: '.claude/skills/demo/SKILL.md' })}owner: "duplicado"\n`
  );
  expectFailure(run(root), 'INVALID_YAML', 'YAML con clave duplicada');
  await write(
    root,
    '.agents/adapters/skill/demo/claude.yaml',
    descriptor({ client: 'claude', output: '.claude/skills/demo/SKILL.md' })
  );

  await write(root, 'plugins/demo/PLUGIN.md', '# Plugin demo\n');
  expectFailure(run(root), 'PLUGIN_ADAPTERS', 'plugin sin adaptadores');
  await rm(path.join(root, 'plugins'), { recursive: true, force: true });

  await write(
    root,
    '.agents/adapters/skill/demo/codex.yaml',
    descriptor({
      client: 'codex',
      output: '.agents/skills/demo/SKILL.md',
    }).replace('strategy: "direct"', 'strategy: "desconocida"')
  );
  expectFailure(
    run(root),
    'DESCRIPTOR_DRIFT',
    'estrategia de drift desconocida'
  );
  await write(
    root,
    '.agents/adapters/skill/demo/codex.yaml',
    descriptor({ client: 'codex', output: '.agents/skills/demo/SKILL.md' })
  );

  await write(
    root,
    '.agents/adapters/skill/demo/codex.yaml',
    descriptor({ client: 'codex', output: '.agents/skills/demo/SKILL.md' })
      .replace(
        'node scripts/ai/check-client-parity.mjs',
        'node scripts/ai/sync-skill-adapters.mjs --check'
      )
      .replace('strategy: "direct"', 'strategy: "generated-check"')
  );
  expectFailure(
    run(root),
    'GENERATED_DRIFT',
    'generated-check fuera de su generador'
  );
  await write(
    root,
    '.agents/adapters/skill/demo/codex.yaml',
    descriptor({ client: 'codex', output: '.agents/skills/demo/SKILL.md' })
  );

  await write(root, '.codex/orphan.toml', 'enabled = true\n');
  expectFailure(
    run(root),
    'CLIENT_RESOURCE_UNMAPPED',
    'recurso de Codex sin adaptador'
  );

  await write(
    root,
    'docs/devops/ai-client-exceptions.yaml',
    `schema_version: 1
exceptions:
  - id: "AIC-EXC-900"
    client: "codex"
    paths:
      - ".codex/orphan.toml"
    reason: "Fixture de capacidad exclusiva."
    owner: "Francisco Maldonado"
    approved_by:
      - "Francisco Maldonado"
    expires_on: "2099-01-01"
    validation:
      command: "node scripts/ai/check-client-parity.mjs"
`
  );
  expectPass(run(root), 'excepción vigente');

  await write(
    root,
    'docs/devops/ai-client-exceptions.yaml',
    `schema_version: 1
exceptions:
  - id: "AIC-EXC-900"
    client: "codex"
    paths:
      - ".codex/orphan.toml"
    reason: "Fixture sin validación."
    owner: "Francisco Maldonado"
    approved_by:
      - "Francisco Maldonado"
    expires_on: "2099-01-01"
    validation: {}
`
  );
  expectFailure(
    run(root),
    'EXCEPTION_METADATA',
    'excepción sin validation.command'
  );

  await write(
    root,
    'docs/devops/ai-client-exceptions.yaml',
    `schema_version: 1
exceptions:
  - id: "AIC-EXC-900"
    client: "codex"
    paths:
      - ".codex/orphan.toml"
    reason: "Fixture con fecha imposible."
    owner: "Francisco Maldonado"
    approved_by:
      - "Francisco Maldonado"
    expires_on: "2099-02-30"
    validation:
      command: "node scripts/ai/check-client-parity.mjs"
`
  );
  expectFailure(run(root), 'EXCEPTION_EXPIRED', 'fecha de excepción imposible');

  await write(
    root,
    'docs/devops/ai-client-exceptions.yaml',
    `schema_version: 1
exceptions:
  - id: "AIC-EXC-900"
    client: "codex"
    paths:
      - ".codex/orphan.toml"
    reason: "Fixture de capacidad exclusiva."
    owner: "Francisco Maldonado"
    approved_by:
      - "Francisco Maldonado"
    expires_on: "2099-01-01"
    validation:
      command: "node scripts/ai/check-client-parity.mjs"
`
  );

  await write(root, '.codex/orphan.toml', 'enabled = "unterminated\n');
  expectFailure(run(root), 'INVALID_TOML', 'TOML inválido');
  await write(root, '.codex/orphan.toml', 'enabled = true\n');

  await write(
    root,
    'docs/devops/ai-client-exceptions.yaml',
    `schema_version: 1
exceptions:
  - id: "AIC-EXC-900"
    client: "codex"
    paths:
      - ".codex/orphan.toml"
    reason: "Fixture vencido."
    owner: "Francisco Maldonado"
    approved_by:
      - "Francisco Maldonado"
    expires_on: "2000-01-01"
    validation:
      command: "node scripts/ai/check-client-parity.mjs"
`
  );
  expectFailure(run(root), 'EXCEPTION_EXPIRED', 'excepción vencida');

  await rm(path.join(root, 'CLAUDE.md'));
  try {
    await symlink('AGENTS.md', path.join(root, 'CLAUDE.md'));
    expectFailure(
      run(root),
      'NON_PORTABLE_CLAUDE_ADAPTER',
      'symlink CLAUDE.md no portable'
    );
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
  }
  await rm(path.join(root, 'CLAUDE.md'), { force: true });
  await write(root, 'CLAUDE.md', '@archivo-inexistente.md\n');
  expectFailure(run(root), 'BROKEN_IMPORT', 'import roto');

  await write(
    root,
    'fixture-token',
    `token = 'sk${'-'}abcdefghijklmnopqrstuvwx'\n`
  );
  expectFailure(run(root), 'SECRET_DETECTED', 'secreto detectado');

  console.log('OK: fixtures de paridad Claude/Codex validados');
} finally {
  await rm(root, { recursive: true, force: true });
}
