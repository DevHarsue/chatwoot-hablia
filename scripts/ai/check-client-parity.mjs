#!/usr/bin/env node

/**
 * Valida la paridad estructural Claude × Codex sin hacer llamadas externas.
 *
 * Uso:
 *   node scripts/ai/check-client-parity.mjs
 *   node scripts/ai/check-client-parity.mjs --repo <ruta>
 *   node scripts/ai/check-client-parity.mjs --format json
 *
 * El validador usa los descriptores versionados en .agents/adapters y las
 * excepciones aprobadas en docs/devops/ai-client-exceptions.yaml. No hay una
 * allowlist implícita para recursos de cliente: todo archivo bajo .claude/,
 * .codex/, manifests de plugin o .mcp.json debe estar cubierto por un
 * adaptador o una excepción vigente.
 */

import { access, lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptDir, "../..");
const args = process.argv.slice(2);
const formatIndex = args.indexOf("--format");
const repoIndex = args.indexOf("--repo");

function usage(message) {
  if (message) console.error(message);
  console.error("Uso: node scripts/ai/check-client-parity.mjs [--repo <ruta>] [--format text|json]");
  process.exit(2);
}

if (args.includes("--help")) usage();
if (repoIndex !== -1 && (!args[repoIndex + 1] || args.filter((arg) => arg === "--repo").length !== 1)) {
  usage("--repo requiere una única ruta");
}
if (formatIndex !== -1 && (!["text", "json"].includes(args[formatIndex + 1]) || args.filter((arg) => arg === "--format").length !== 1)) {
  usage("--format acepta text o json");
}
const knownArgumentIndexes = new Set();
if (repoIndex !== -1) {
  knownArgumentIndexes.add(repoIndex);
  knownArgumentIndexes.add(repoIndex + 1);
}
if (formatIndex !== -1) {
  knownArgumentIndexes.add(formatIndex);
  knownArgumentIndexes.add(formatIndex + 1);
}
if (args.some((arg, index) => !knownArgumentIndexes.has(index))) usage("Argumento no reconocido");

const root = repoIndex === -1 ? workspaceRoot : path.resolve(workspaceRoot, args[repoIndex + 1]);
const outputFormat = formatIndex === -1 ? "text" : args[formatIndex + 1];
const errors = [];

function fail(code, message) {
  errors.push({ code, message });
}

function normalizeRelative(value, label) {
  const normalized = String(value || "").trim().replaceAll("\\", "/").replace(/\/+$/, "");
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`${label}: ruta relativa inválida (${value || "vacía"})`);
  }
  return normalized.replace(/^\.\//, "");
}

function unquote(value) {
  const trimmed = String(value || "").trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scalar(text, name, indentation = 0) {
  const pattern = new RegExp(`^ {${indentation}}${escaped(name)}:\\s*(.+?)\\s*$`, "m");
  const match = text.match(pattern);
  return match ? unquote(match[1]) : "";
}

function section(text, name, indentation = 0) {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const start = lines.findIndex((line) => new RegExp(`^ {${indentation}}${escaped(name)}:\\s*$`).test(line));
  if (start === -1) return "";
  const next = lines.slice(start + 1).findIndex((line) => line.trim() && !line.trimStart().startsWith("#") && !line.startsWith(" ".repeat(indentation + 1)));
  const end = next === -1 ? lines.length : start + 1 + next;
  return lines.slice(start + 1, end).join("\n");
}

function list(text, name, indentation = 0) {
  const inline = text.match(new RegExp(`^ {${indentation}}${escaped(name)}:\\s*\\[\\]\\s*$`, "m"));
  if (inline) return [];
  const body = section(text, name, indentation);
  if (!body) return null;
  const entries = body.split("\n").filter((line) => line.trim() && !line.trimStart().startsWith("#"));
  const item = new RegExp(`^ {${indentation + 2}}-[ ]+(.+)$`);
  if (entries.some((line) => !item.test(line))) return null;
  return entries.map((line) => unquote(line.match(item)[1].trim()));
}

function mapping(text, name, indentation = 0) {
  if (new RegExp(`^ {${indentation}}${escaped(name)}:\\s*\\{\\}\\s*$`, "m").test(text)) return true;
  const body = section(text, name, indentation);
  if (!body) return false;
  const entries = body.split("\n").filter((line) => line.trim() && !line.trimStart().startsWith("#"));
  const directEntries = entries.filter((line) => line.match(/^ */)[0].length === indentation + 2);
  return directEntries.length > 0 && directEntries.every((line) => new RegExp(`^ {${indentation + 2}}[A-Za-z0-9_-]+:`).test(line));
}

function validateYamlShape(content, file) {
  const rootNode = { indentation: -2, childKind: "mapping", canHaveChildren: true };
  const stack = [rootNode];
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  for (const [index, rawLine] of lines.entries()) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;
    if (rawLine.includes("\t")) {
      fail("INVALID_YAML", `${file}:${index + 1}: no se permiten tabulaciones`);
      continue;
    }
    const indentation = rawLine.match(/^ */)[0].length;
    if (indentation % 2 !== 0) {
      fail("INVALID_YAML", `${file}:${index + 1}: la indentación debe usar múltiplos de dos`);
      continue;
    }
    const contentLine = rawLine.slice(indentation);
    const sequence = contentLine.match(/^-\s+(.+)$/);
    const mapping = contentLine.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!sequence && !mapping) {
      fail("INVALID_YAML", `${file}:${index + 1}: sintaxis YAML fuera del subconjunto permitido`);
      continue;
    }
    const kind = sequence ? "sequence" : "mapping";
    const value = sequence ? sequence[1] : mapping[2] || "";
    const inlineMapping = sequence && value.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
    const scalarValue = inlineMapping ? inlineMapping[2] : value;
    const doubleQuoted = scalarValue.startsWith('"');
    const singleQuoted = scalarValue.startsWith("'");
    if ((doubleQuoted && !/^"(?:[^"\\]|\\.)*"$/.test(scalarValue)) || (singleQuoted && !/^'(?:[^']|'')*'$/.test(scalarValue))) {
      fail("INVALID_YAML", `${file}:${index + 1}: string entre comillas inválida o sin cierre`);
      continue;
    }
    if (!doubleQuoted && !singleQuoted && /:\s/.test(scalarValue)) {
      fail("INVALID_YAML", `${file}:${index + 1}: los escalares con dos puntos deben estar entre comillas`);
      continue;
    }
    if ((scalarValue.startsWith("[") && scalarValue !== "[]") || (scalarValue.startsWith("{") && scalarValue !== "{}")) {
      fail("INVALID_YAML", `${file}:${index + 1}: colecciones inline no están permitidas por este contrato`);
      continue;
    }

    while (stack.length > 1 && stack.at(-1).indentation >= indentation) stack.pop();
    const parent = stack.at(-1);
    if (indentation !== parent.indentation + 2) {
      fail("INVALID_YAML", `${file}:${index + 1}: la estructura salta un nivel de indentación`);
      continue;
    }
    if (!parent.canHaveChildren) {
      fail("INVALID_YAML", `${file}:${index + 1}: un valor escalar no puede contener hijos`);
      continue;
    }
    if (parent.childKind && parent.childKind !== kind) {
      fail("INVALID_YAML", `${file}:${index + 1}: no se pueden mezclar listas y mapas en el mismo nivel`);
      continue;
    }
    parent.childKind ||= kind;
    if (mapping) {
      parent.keys ||= new Set();
      if (parent.keys.has(mapping[1])) {
        fail("INVALID_YAML", `${file}:${index + 1}: clave duplicada (${mapping[1]})`);
        continue;
      }
      parent.keys.add(mapping[1]);
    }
    const node = {
      indentation,
      childKind: null,
      canHaveChildren: (!sequence && !value) || Boolean(inlineMapping),
      keys: new Set(),
    };
    if (inlineMapping) node.keys.add(inlineMapping[1]);
    stack.push(node);
  }
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function listRepositoryFiles(directory) {
  try {
    const raw = execFileSync("git", ["-C", directory, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return raw.split("\0").filter(Boolean).map((file) => file.replaceAll("\\", "/")).sort();
  } catch {
    const files = [];
    async function visit(current) {
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        if ([".git", "node_modules", "__pycache__"].includes(entry.name)) continue;
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) await visit(fullPath);
        if (entry.isFile()) files.push(path.relative(directory, fullPath).split(path.sep).join("/"));
      }
    }
    await visit(directory);
    return files.sort();
  }
}

function descriptorClientPath(client, file) {
  if (client === "claude") {
    return file === ".mcp.json" || file.startsWith(".claude/") || /^plugins\/[^/]+\/\.claude-plugin\//.test(file);
  }
  return file.startsWith(".codex/") || /^plugins\/[^/]+\/\.codex-plugin\//.test(file);
}

function covers(output, file) {
  return file === output || file.startsWith(`${output}/`);
}

function parseDescriptor(content, descriptorPath) {
  const resource = section(content, "resource");
  const drift = section(content, "drift");
  const validation = section(content, "validation");
  const parsed = {
    path: descriptorPath,
    schemaVersion: scalar(content, "schema_version"),
    type: scalar(resource, "type", 2),
    name: scalar(resource, "name", 2),
    source: scalar(content, "source"),
    client: scalar(content, "client"),
    outputs: list(content, "outputs"),
    transformations: list(content, "transformations"),
    hasCapabilityMapping: mapping(content, "capability_mapping"),
    strategy: scalar(drift, "strategy", 2),
    sourceHash: scalar(drift, "source_sha256", 2),
    outputHash: scalar(drift, "output_sha256", 2),
    validationCommands: list(validation, "commands", 2) || [],
    owner: scalar(content, "owner"),
    exceptionIds: list(content, "exception_ids") || [],
  };
  if (parsed.schemaVersion !== "1") fail("DESCRIPTOR_SCHEMA", `${descriptorPath}: schema_version debe ser 1`);
  if (!parsed.type || !parsed.name) fail("DESCRIPTOR_RESOURCE", `${descriptorPath}: resource.type y resource.name son obligatorios`);
  if (!["claude", "codex"].includes(parsed.client)) fail("DESCRIPTOR_CLIENT", `${descriptorPath}: client debe ser claude o codex`);
  if (!parsed.source) fail("DESCRIPTOR_SOURCE", `${descriptorPath}: source es obligatorio`);
  if (!Array.isArray(parsed.outputs) || !parsed.outputs.length) fail("DESCRIPTOR_OUTPUTS", `${descriptorPath}: outputs no puede estar vacío`);
  if (!Array.isArray(parsed.transformations)) fail("DESCRIPTOR_CONTRACT", `${descriptorPath}: transformations es obligatorio (puede ser [])`);
  if (!parsed.hasCapabilityMapping) fail("DESCRIPTOR_CONTRACT", `${descriptorPath}: capability_mapping es obligatorio (puede ser {})`);
  if (!parsed.validationCommands.length) fail("DESCRIPTOR_CONTRACT", `${descriptorPath}: validation.commands no puede estar vacío`);
  if (!parsed.owner) fail("DESCRIPTOR_OWNER", `${descriptorPath}: owner es obligatorio`);
  if (!["direct", "sha256", "generated-check"].includes(parsed.strategy)) {
    fail("DESCRIPTOR_DRIFT", `${descriptorPath}: drift.strategy debe ser direct, sha256 o generated-check`);
  }
  return parsed;
}

function parseExceptions(content, exceptionsPath) {
  if (scalar(content, "schema_version") !== "1") {
    throw new Error(`${exceptionsPath}: schema_version debe ser 1`);
  }
  if (/^exceptions:\s*\[\]\s*$/m.test(content)) return [];
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const records = [];
  let current = null;
  for (const line of lines) {
    const start = line.match(/^  - id:\s*(.+?)\s*$/);
    if (start) {
      if (current) records.push(current);
      current = { id: unquote(start[1]), paths: [], approvers: [], validationCommand: "", list: "", section: "" };
      continue;
    }
    if (!current) continue;
    if (/^    paths:\s*$/.test(line)) {
      current.list = "paths";
      current.section = "";
      continue;
    }
    if (/^    approved_by:\s*$/.test(line)) {
      current.list = "approved_by";
      current.section = "";
      continue;
    }
    if (/^    validation:\s*$/.test(line)) {
      current.list = "";
      current.section = "validation";
      continue;
    }
    const validationCommand = line.match(/^      command:\s*(.+?)\s*$/);
    if (validationCommand && current.section === "validation") {
      current.validationCommand = unquote(validationCommand[1]);
      continue;
    }
    const value = line.match(/^    ([a-z_]+):\s*(.*?)\s*$/);
    if (value) {
      const [, key, raw] = value;
      current.list = "";
      current.section = "";
      if (key !== "validation" && raw) current[key] = unquote(raw);
      continue;
    }
    const listItem = line.match(/^      -\s*(.+?)\s*$/);
    if (listItem) {
      if (current.list === "paths") current.paths.push(unquote(listItem[1]));
      if (current.list === "approved_by") current.approvers.push(unquote(listItem[1]));
      continue;
    }
  }
  if (current) records.push(current);

  for (const record of records) {
    delete record.list;
    delete record.section;
    if (!/^AIC-EXC-\d{3,}$/.test(record.id || "")) fail("EXCEPTION_ID", `${exceptionsPath}: id inválido (${record.id || "vacío"})`);
    if (!["claude", "codex"].includes(record.client)) fail("EXCEPTION_CLIENT", `${record.id}: client debe ser claude o codex`);
    if (!record.paths.length) fail("EXCEPTION_PATH", `${record.id}: paths no puede estar vacío`);
    if (!record.reason || !record.owner || !record.approvers.length || !record.expires_on || !record.validationCommand) {
      fail("EXCEPTION_METADATA", `${record.id}: requiere reason, owner, approved_by, expires_on y validation`);
    }
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    const expiry = new Date(`${record.expires_on}T23:59:59Z`);
    if (!datePattern.test(record.expires_on || "") || Number.isNaN(expiry.valueOf()) || expiry.toISOString().slice(0, 10) !== record.expires_on || expiry < new Date()) {
      fail("EXCEPTION_EXPIRED", `${record.id}: excepción vencida o fecha inválida (${record.expires_on || "vacía"})`);
    }
    for (const rawPath of record.paths) {
      try {
        const exceptionPath = normalizeRelative(rawPath, `${record.id}.paths`);
        if (!descriptorClientPath(record.client, exceptionPath)) {
          fail("EXCEPTION_SCOPE", `${record.id}: ${exceptionPath} no pertenece al adaptador ${record.client}`);
        }
      } catch (error) {
        fail("EXCEPTION_PATH", error.message);
      }
    }
  }
  return records;
}

function exceptionCovers(exception, file) {
  return exception.paths.some((value) => {
    try {
      return covers(normalizeRelative(value, `${exception.id}.paths`), file);
    } catch {
      return false;
    }
  });
}

async function validateExceptionWorkflowMappings(exceptions) {
  for (const exception of exceptions) {
    const commandPaths = exception.paths.filter((value) => {
      try {
        const candidate = normalizeRelative(value, `${exception.id}.paths`);
        return covers(candidate, ".claude/commands") || candidate.startsWith(".claude/commands/");
      } catch (error) {
        fail("EXCEPTION_COMMAND_SCOPE", error.message);
        return false;
      }
    });
    if (!commandPaths.length) continue;

    let workflowMap;
    try {
      workflowMap = normalizeRelative(exception.workflow_map, `${exception.id}.workflow_map`);
      if (workflowMap.startsWith(".claude/") || workflowMap.startsWith(".codex/")) {
        fail("EXCEPTION_WORKFLOW_MAP", `${exception.id}: workflow_map debe ser portable (${workflowMap})`);
        continue;
      }
      if (!(await exists(path.join(root, workflowMap)))) {
        fail("EXCEPTION_WORKFLOW_MAP", `${exception.id}: workflow_map inexistente (${workflowMap})`);
        continue;
      }
    } catch (error) {
      fail("EXCEPTION_WORKFLOW_MAP", error.message);
      continue;
    }

    const workflowContent = await readFile(path.join(root, workflowMap), "utf8");
    for (const rawPath of commandPaths) {
      let commandPath;
      try {
        commandPath = normalizeRelative(rawPath, `${exception.id}.paths`);
      } catch (error) {
        fail("EXCEPTION_COMMAND_SCOPE", error.message);
        continue;
      }
      if (!/^\.claude\/commands\/[a-z0-9][a-z0-9-]*\.md$/.test(commandPath)) {
        fail("EXCEPTION_COMMAND_SCOPE", `${exception.id}: los comandos deben declararse como archivos explícitos (${commandPath})`);
        continue;
      }
      if (!(await exists(path.join(root, commandPath)))) {
        fail("EXCEPTION_COMMAND_PATH", `${exception.id}: comando inexistente (${commandPath})`);
        continue;
      }
      const command = path.posix.basename(commandPath, ".md");
      const row = new RegExp(`^\\|\\s*\\\`/${escaped(command)}\\\`\\s*\\|`, "m");
      if (!row.test(workflowContent)) {
        fail("EXCEPTION_WORKFLOW", `${exception.id}: falta el workflow portable para /${command} en ${workflowMap}`);
      }
    }
  }
}

async function validateDescriptors(files, exceptions) {
  const descriptors = [];
  const generatedChecks = new Set();
  const descriptorFiles = files.filter((file) => /^\.agents\/adapters\/[^/]+\/[^/]+\/(claude|codex)\.yaml$/.test(file));
  for (const descriptorPath of descriptorFiles) {
    const content = await readFile(path.join(root, descriptorPath), "utf8");
    validateYamlShape(content, descriptorPath);
    const descriptor = parseDescriptor(content, descriptorPath);
    descriptors.push(descriptor);
    const expected = `.agents/adapters/${descriptor.type}/${descriptor.name}/${descriptor.client}.yaml`;
    if (descriptorPath !== expected) fail("DESCRIPTOR_LOCATION", `${descriptorPath}: la ubicación no coincide con resource/client`);
    try {
      const source = normalizeRelative(descriptor.source, `${descriptorPath}.source`);
      if (source.startsWith(".claude/") || source.startsWith(".codex/") || /^plugins\/[^/]+\/\.(claude|codex)-plugin\//.test(source)) {
        fail("CLIENT_AS_SOURCE", `${descriptorPath}: source no puede ubicarse bajo una ruta exclusiva de cliente`);
      }
      if (!(await exists(path.join(root, source)))) fail("BROKEN_SOURCE", `${descriptorPath}: source inexistente (${source})`);
      descriptor.source = source;
      descriptor.outputs = descriptor.outputs.map((value) => normalizeRelative(value, `${descriptorPath}.outputs`));
    } catch (error) {
      fail("DESCRIPTOR_PATH", error.message);
      descriptor.outputs = [];
    }
    for (const output of descriptor.outputs) {
      if (!(await exists(path.join(root, output)))) fail("BROKEN_OUTPUT", `${descriptorPath}: output inexistente (${output})`);
    }
    if (descriptor.strategy === "direct") {
      const sourceContent = await readFile(path.join(root, descriptor.source));
      for (const output of descriptor.outputs) {
        try {
          const outputContent = await readFile(path.join(root, output));
          if (!sourceContent.equals(outputContent)) {
            fail("DIRECT_DRIFT", `${descriptorPath}: source y output difieren; use sha256 o generated-check si hay transformación`);
          }
        } catch {
          fail("DIRECT_DRIFT", `${descriptorPath}: direct requiere un output de archivo comparable (${output})`);
        }
      }
    }
    if (descriptor.strategy === "sha256") {
      if (!/^[a-f0-9]{64}$/.test(descriptor.sourceHash) || !/^[a-f0-9]{64}$/.test(descriptor.outputHash) || descriptor.outputs.length !== 1) {
        fail("SHA256_DRIFT", `${descriptorPath}: sha256 requiere source_sha256, output_sha256 y un único output`);
      } else {
        const sourceContent = await readFile(path.join(root, descriptor.source));
        const outputContent = await readFile(path.join(root, descriptor.outputs[0]));
        if (sha256(sourceContent) !== descriptor.sourceHash) fail("SHA256_DRIFT", `${descriptorPath}: source_sha256 no coincide`);
        if (sha256(outputContent) !== descriptor.outputHash) fail("SHA256_DRIFT", `${descriptorPath}: output_sha256 no coincide`);
      }
    }
    if (descriptor.strategy === "generated-check") {
      const command = "node scripts/ai/sync-skill-adapters.mjs --check";
      const expectedSource = `.agents/skills/${descriptor.name}/SKILL.md`;
      const expectedOutput = `.claude/skills/${descriptor.name}`;
      const generatedSkill = descriptor.type === "skill"
        && descriptor.client === "claude"
        && descriptor.source === expectedSource
        && descriptor.outputs.length === 1
        && descriptor.outputs[0] === expectedOutput;
      if (!generatedSkill || !descriptor.validationCommands.includes(command)) {
        fail("GENERATED_DRIFT", `${descriptorPath}: generated-check solo aplica a adaptadores Claude de skills generados por ${command}`);
      } else {
        generatedChecks.add(command);
      }
    }
    for (const exceptionId of descriptor.exceptionIds) {
      if (!exceptions.some((exception) => exception.id === exceptionId)) {
        fail("UNKNOWN_EXCEPTION", `${descriptorPath}: exception_id desconocido (${exceptionId})`);
      }
    }
  }

  const byResource = new Map();
  for (const descriptor of descriptors) {
    const key = `${descriptor.type}/${descriptor.name}`;
    const clients = byResource.get(key) || new Map();
    if (clients.has(descriptor.client)) fail("DUPLICATE_DESCRIPTOR", `${key}: hay más de un descriptor ${descriptor.client}`);
    clients.set(descriptor.client, descriptor);
    byResource.set(key, clients);
  }
  for (const [key, clients] of byResource) {
    if (clients.has("claude") && clients.has("codex")) continue;
    const only = clients.get("claude") || clients.get("codex");
    const waived = only.exceptionIds.length > 0 && only.outputs.every((output) =>
      only.exceptionIds.some((id) => {
        const exception = exceptions.find((candidate) => candidate.id === id);
        return exception && exceptionCovers(exception, output);
      }),
    );
    if (!waived) fail("MISSING_CLIENT_ADAPTER", `${key}: faltan adaptadores Claude o Codex, sin excepción vigente`);
  }

  for (const file of files.filter((candidate) => /^\.agents\/skills\/[^/]+\/SKILL\.md$/.test(candidate))) {
    const name = file.split("/")[2];
    const resource = byResource.get(`skill/${name}`);
    if (!resource || !resource.has("claude") || !resource.has("codex")) {
      fail("SKILL_ADAPTERS", `${file}: faltan descriptores Claude/Codex`);
    }
  }
  for (const file of files.filter((candidate) => /^\.agents\/agents\/[^/]+\/AGENT\.md$/.test(candidate))) {
    const name = file.split("/")[2];
    const resource = byResource.get(`agent/${name}`);
    if (!resource || !resource.has("claude") || !resource.has("codex")) {
      fail("AGENT_ADAPTERS", `${file}: faltan descriptores Claude/Codex`);
    }
  }
  for (const file of files.filter((candidate) => /^plugins\/[^/]+\/PLUGIN\.md$/.test(candidate))) {
    const name = file.split("/")[1];
    const resource = byResource.get(`plugin/${name}`);
    if (!resource) {
      fail("PLUGIN_ADAPTERS", `${file}: faltan descriptores Claude/Codex o una excepción AIC`);
      continue;
    }
    for (const client of ["claude", "codex"]) {
      const manifest = `plugins/${name}/.${client}-plugin/plugin.json`;
      if (files.includes(manifest)) continue;
      const descriptor = resource.get(client);
      const allowed = descriptor?.exceptionIds.some((id) => {
        const exception = exceptions.find((candidate) => candidate.id === id);
        return exception?.client === client && exceptionCovers(exception, manifest);
      });
      if (!allowed) fail("PLUGIN_MANIFEST", `${file}: falta ${manifest} sin excepción AIC vigente`);
    }
  }
  for (const command of generatedChecks) {
    const result = spawnSync(process.execPath, [path.join(root, "scripts/ai/sync-skill-adapters.mjs"), "--check"], {
      cwd: root,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      fail("GENERATED_DRIFT", `${command}: falló\n${(result.stderr || result.stdout || "sin salida").trim()}`);
    }
  }
  return descriptors;
}

async function validateClientCoverage(files, descriptors, exceptions) {
  const candidates = files.filter((file) => descriptorClientPath("claude", file) || descriptorClientPath("codex", file));
  const usedExceptions = new Set();
  for (const file of candidates) {
    const client = descriptorClientPath("claude", file) ? "claude" : "codex";
    if (descriptors.some((descriptor) => descriptor.client === client && descriptor.outputs.some((output) => covers(output, file)))) continue;
    const exception = exceptions.find((candidate) => candidate.client === client && exceptionCovers(candidate, file));
    if (exception) {
      usedExceptions.add(exception.id);
      continue;
    }
    fail("CLIENT_RESOURCE_UNMAPPED", `${file}: recurso exclusivo de ${client} sin descriptor ni excepción vigente`);
  }
  for (const exception of exceptions) {
    if (!usedExceptions.has(exception.id) && !descriptors.some((descriptor) => descriptor.exceptionIds.includes(exception.id))) {
      fail("UNUSED_EXCEPTION", `${exception.id}: no cubre ningún recurso ni descriptor`);
    }
  }
}

async function validateImports(files) {
  const claudeAdapter = path.join(root, "CLAUDE.md");
  try {
    const metadata = await lstat(claudeAdapter);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      fail(
        "NON_PORTABLE_CLAUDE_ADAPTER",
        "CLAUDE.md debe ser un archivo regular que importe @AGENTS.md; no se admite un symlink como único mecanismo.",
      );
    }
  } catch (error) {
    fail("MISSING_CLAUDE_ADAPTER", `CLAUDE.md no está disponible como archivo regular (${error.message})`);
  }
  const importable = (candidate) => candidate === "CLAUDE.md"
    || candidate.startsWith(".claude/")
    || candidate.startsWith(".agents/")
    || /^plugins\/[^/]+\/(?:PLUGIN\.md|skills\/|agents\/)/.test(candidate);
  for (const file of files.filter((candidate) => candidate.endsWith(".md") && importable(candidate))) {
    const content = await readFile(path.join(root, file), "utf8");
    for (const line of content.replaceAll("\r\n", "\n").split("\n")) {
      const match = line.match(/^@([A-Za-z0-9][A-Za-z0-9_./-]*)\s*$/);
      if (!match) continue;
      try {
        const imported = normalizeRelative(path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1])), `${file} import`);
        if (!(await exists(path.join(root, imported)))) fail("BROKEN_IMPORT", `${file}: import inexistente @${match[1]}`);
      } catch (error) {
        fail("BROKEN_IMPORT", error.message);
      }
    }
  }
}

async function validateReviewGuidelines() {
  const guidelinesPath = path.join(root, "REVIEW_GUIDELINES.md");
  if (!(await exists(guidelinesPath))) {
    fail("MISSING_REVIEW_GUIDELINES", "Falta REVIEW_GUIDELINES.md para el pre-review portable");
    return;
  }
  const content = await readFile(guidelinesPath, "utf8");
  const requiredSections = [
    "## Severidades",
    "## NEVER",
    "## Validación y límites",
    "## Formato de salida",
    "## BLOCKING (n)",
    "## WARNINGS (n)",
    "## SUGGESTIONS (n)",
    "## Verdict",
  ];
  for (const sectionName of requiredSections) {
    if (!content.includes(sectionName)) {
      fail("REVIEW_GUIDELINES_CONTRACT", `REVIEW_GUIDELINES.md: falta la sección ${sectionName}`);
    }
  }
}

function validateToml(file) {
  const parser = path.join(scriptDir, "parse_toml.py");
  const runners = process.platform === "win32"
    ? [["py", ["-3", parser, path.join(root, file)]], ["python3", [parser, path.join(root, file)]]]
    : [["python3", [parser, path.join(root, file)]], ["py", ["-3", parser, path.join(root, file)]]];
  for (const [command, commandArgs] of runners) {
    const result = spawnSync(command, commandArgs, { encoding: "utf8" });
    if (result.error?.code === "ENOENT") continue;
    if (result.status === 0) return;
    fail("INVALID_TOML", `${file}: ${(result.stderr || result.stdout || "el parser TOML falló").trim()}`);
    return;
  }
  fail("TOML_PARSER_UNAVAILABLE", `${file}: se requiere Python 3.11+ con tomllib para validar TOML`);
}

async function validateManifests(files) {
  for (const file of files.filter((candidate) => candidate === ".mcp.json" || /(^|\/)\.(claude|codex)-plugin\/plugin\.json$/.test(candidate))) {
    try {
      const parsed = JSON.parse(await readFile(path.join(root, file), "utf8"));
      if (file === ".mcp.json" && (!parsed.mcpServers || typeof parsed.mcpServers !== "object" || Array.isArray(parsed.mcpServers))) {
        fail("INVALID_MCP_MANIFEST", `${file}: mcpServers debe ser un objeto`);
      }
      if (file.endsWith("plugin.json")) {
        const pluginName = file.split("/")[1];
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(parsed.name || "") || parsed.name !== pluginName) {
          fail("INVALID_PLUGIN_MANIFEST", `${file}: name debe coincidir con el directorio del plugin`);
        }
        if (parsed.version && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(parsed.version)) {
          fail("INVALID_PLUGIN_MANIFEST", `${file}: version debe usar semver estricto`);
        }
      }
    } catch (error) {
      fail("INVALID_JSON_MANIFEST", `${file}: JSON inválido (${error.message})`);
    }
  }
  for (const file of files.filter((candidate) => candidate.endsWith(".toml"))) {
    validateToml(file);
  }
}

async function scanSecrets(files) {
  const patterns = [
    ["GITHUB_TOKEN", /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
    ["OPENAI_OR_SIMILAR_KEY", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
    ["GOOGLE_API_KEY", /\bAIza[0-9A-Za-z_-]{20,}\b/],
    ["SLACK_TOKEN", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
    ["AWS_ACCESS_KEY", /\bAKIA[0-9A-Z]{16}\b/],
    ["PRIVATE_KEY", /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/],
  ];
  for (const file of files) {
    const bytes = await readFile(path.join(root, file));
    if (bytes.includes(0) || bytes.toString("utf8").includes("\uFFFD")) continue;
    const lines = bytes.toString("utf8").replaceAll("\r\n", "\n").split("\n");
    for (const [index, line] of lines.entries()) {
      for (const [kind, pattern] of patterns) {
        if (pattern.test(line)) fail("SECRET_DETECTED", `${file}:${index + 1}: patrón ${kind} detectado`);
      }
    }
  }
}

async function main() {
  if (!(await exists(root))) usage(`No existe el repositorio: ${root}`);
  const files = await listRepositoryFiles(root);
  const exceptionsPath = path.join(root, "docs", "devops", "ai-client-exceptions.yaml");
  if (!(await exists(exceptionsPath))) {
    fail("MISSING_EXCEPTION_REGISTRY", "Falta docs/devops/ai-client-exceptions.yaml");
  }
  const exceptionsContent = (await exists(exceptionsPath))
    ? await readFile(exceptionsPath, "utf8")
    : "";
  if (exceptionsContent) validateYamlShape(exceptionsContent, "docs/devops/ai-client-exceptions.yaml");
  const exceptions = exceptionsContent
    ? parseExceptions(exceptionsContent, "docs/devops/ai-client-exceptions.yaml")
    : [];
  await validateExceptionWorkflowMappings(exceptions);
  const descriptors = await validateDescriptors(files, exceptions);
  await validateClientCoverage(files, descriptors, exceptions);
  await validateImports(files);
  await validateReviewGuidelines();
  await validateManifests(files);
  await scanSecrets(files);

  errors.sort((left, right) => `${left.code}:${left.message}`.localeCompare(`${right.code}:${right.message}`));
  if (outputFormat === "json") {
    console.log(JSON.stringify({ root, valid: errors.length === 0, errors }, null, 2));
  } else if (errors.length) {
    console.error(`Paridad Claude/Codex: ${errors.length} error(es).`);
    for (const error of errors) console.error(`- [${error.code}] ${error.message}`);
  } else {
    console.log("Paridad Claude/Codex validada: adaptadores, excepciones, rutas, manifests e indicadores de secretos conformes.");
  }
  process.exit(errors.length ? 1 : 0);
}

main().catch((error) => {
  console.error(`Error de configuración de paridad: ${error.message}`);
  process.exit(2);
});
