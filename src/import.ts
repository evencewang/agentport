import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

import { loadConfig } from "./config.js";
import {
  applyEnvPolicyToServer,
  NON_INTERACTIVE_ENV_POLICY,
  normalizeMcpEnvAndHeaders,
  redactValue,
  type EnvActionItem,
  type EnvPolicy,
  type RawEnvSourceMcp
} from "./import-env.js";
import {
  IMPORT_CATEGORIES,
  IMPORT_SOURCES,
  TARGETS,
  type AgentportConfig,
  type CommandConfig,
  type ConcreteImportCategory,
  type ImportCategory,
  type ImportSource,
  type McpServerConfig,
  type SkillConfig,
  type Target
} from "./types.js";

const CONCRETE_CATEGORIES: ConcreteImportCategory[] = ["mcp", "skills", "commands"];
const HELP_HINT = "Run agentport --help for usage.";

type ConfigCategory = "mcpServers" | "skills" | "commands";
type ImportedItem = McpServerConfig | SkillConfig | CommandConfig;

export type ConflictSource = "base-config" | "earlier-candidate";

export type CandidateClassification =
  | { kind: "new" }
  | { kind: "unchanged" }
  | { kind: "merge"; mergedTargets: Target[] }
  | {
      kind: "conflict";
      differenceDimensions: string[];
      safeMergeAvailable: boolean;
      conflictSource: ConflictSource;
      existing: ImportedItem;
      existingSummary: string;
      incomingSummary: string;
    };

export interface DiscoveredItem {
  id: string;
  category: ConcreteImportCategory;
  item: ImportedItem;
  source: ImportSource;
  sourcePath: string;
  classification: CandidateClassification;
  possibleDuplicates: ImportPossibleDuplicate[];
  envActionItems: EnvActionItem[];
}

export interface ImportDiscoveryStatus {
  source: ImportSource;
  category: ConcreteImportCategory;
  supported: boolean;
  discovered: number;
  reason?: string;
}

export interface ImportOptions {
  configPath: string;
  sourceDir: string;
  sources: ImportSource[];
  categories: ImportCategory[];
  dryRun?: boolean;
  envPolicy?: EnvPolicy;
}

export interface ImportSkip {
  source: ImportSource;
  category: ConcreteImportCategory;
  reason: string;
}

export interface ImportWarning {
  source: ImportSource;
  category: ConcreteImportCategory;
  name?: string;
  sourcePath?: string;
  message: string;
}

export interface ImportConflict {
  category: ConcreteImportCategory;
  name: string;
  sourcePath: string;
  message: string;
}

export interface ImportMerge {
  category: "mcp";
  name: string;
  sourcePath: string;
  mergedTargets: Target[];
  message: string;
}

export interface ImportPossibleDuplicate {
  category: "mcp";
  importedName: string;
  existingName: string;
  sourcePath: string;
  message: string;
}

export interface ImportCounts {
  imported: number;
  skipped: number;
  unchanged: number;
  conflicts: number;
  warnings: number;
}

export interface ImportPlan {
  configPath: string;
  sourceDir: string;
  sources: ImportSource[];
  categories: ConcreteImportCategory[];
  baseConfig: AgentportConfig;
  candidates: DiscoveredItem[];
  discovery: ImportDiscoveryStatus[];
  skipped: ImportSkip[];
  warnings: ImportWarning[];
  envActionItems: EnvActionItem[];
  envPolicy: EnvPolicy;
}

export type ConflictAction =
  | { type: "keep" }
  | { type: "replace" }
  | { type: "rename"; newName: string }
  | { type: "merge" }
  | { type: "skip" }
  | { type: "abort" };

export interface EnvOverride {
  candidateId: string;
  fieldKind: "env" | "header";
  fieldKey: string;
  envVar: string;
}

export interface ResolvedSelection {
  selectedIds: Set<string>;
  conflictActions: Map<string, ConflictAction>;
  envOverrides?: EnvOverride[];
}

export interface ApplyImportOptions {
  plan: ImportPlan;
  selection?: ResolvedSelection;
  dryRun?: boolean;
}

export interface ImportResult {
  configPath: string;
  sourceDir: string;
  sources: ImportSource[];
  categories: ConcreteImportCategory[];
  imported: DiscoveredItem[];
  discovery: ImportDiscoveryStatus[];
  skipped: ImportSkip[];
  unchanged: DiscoveredItem[];
  merged: ImportMerge[];
  conflicts: ImportConflict[];
  possibleDuplicates: ImportPossibleDuplicate[];
  warnings: ImportWarning[];
  envActionItems: EnvActionItem[];
  countsByCategory: Record<ConcreteImportCategory, ImportCounts>;
  configWritten: boolean;
  configChanged: boolean;
  dryRun: boolean;
  aborted: boolean;
  mergedConfig: AgentportConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function safeReadDir(dirPath: string): Promise<string[]> {
  try {
    return (await readdir(dirPath)).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

async function readJsonFile(filePath: string): Promise<unknown | undefined> {
  if (!(await fileExists(filePath))) {
    return undefined;
  }

  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid MCP JSON at ${filePath}: ${message}. Fix the file or exclude mcp.`);
  }
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.map((item) => String(item));
}

function asTargets(value: unknown): Target[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const targets: Target[] = [];
  const seen = new Set<Target>();
  for (const item of value) {
    const target = String(item);
    if (TARGETS.includes(target as Target) && !seen.has(target as Target)) {
      targets.push(target as Target);
      seen.add(target as Target);
    }
  }

  return targets.length > 0 ? targets : undefined;
}

interface NormalizedMcpResult {
  server: McpServerConfig;
  actionItems: EnvActionItem[];
}

function normalizeMcpServer(
  name: string,
  raw: unknown,
  source: ImportSource,
  sourcePath: string,
  warnings: ImportWarning[],
  policy: EnvPolicy
): NormalizedMcpResult | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const rawEnv = asStringRecord(raw.env);
  const rawHeaders = asStringRecord(raw.headers) ?? asStringRecord(raw.http_headers);
  const rawEnvHttpHeaders = asStringRecord(raw.env_http_headers);
  const bearerCandidates = ["bearer_token_env_var", "bearerTokenEnvVar"];
  const bearerKey = bearerCandidates.find((key) => typeof raw[key] === "string");
  const bearerTokenEnvVar = bearerKey ? String(raw[bearerKey]) : undefined;

  const commandArray = asStringArray(raw.command);
  const command = commandArray ? commandArray[0] : typeof raw.command === "string" ? raw.command : undefined;
  const args = commandArray ? commandArray.slice(1) : asStringArray(raw.args);
  const url = typeof raw.url === "string" ? raw.url : undefined;
  const targets = asTargets(raw.targets);
  const type = typeof raw.type === "string" ? raw.type : undefined;
  const explicitTransport = typeof raw.transport === "string" ? raw.transport : undefined;

  const rawShape: RawEnvSourceMcp = {
    ...(rawEnv ? { env: rawEnv } : {}),
    ...(rawHeaders ? { headers: rawHeaders } : {}),
    ...(rawEnvHttpHeaders ? { envHttpHeaders: rawEnvHttpHeaders } : {}),
    ...(bearerTokenEnvVar ? { bearerTokenEnvVar } : {})
  };
  const normalized = normalizeMcpEnvAndHeaders(name, rawShape, policy);

  const hasEnvLike =
    rawEnv ||
    rawHeaders ||
    rawEnvHttpHeaders ||
    bearerTokenEnvVar ||
    Object.keys(raw).some((key) => key.includes("bearer"));
  if (hasEnvLike) {
    warnings.push({
      source,
      category: "mcp",
      name,
      sourcePath,
      message: `MCP server "${name}" imports env/header-like values; review ${sourcePath} before committing.`
    });
  }

  if (command) {
    const server: McpServerConfig = {
      name,
      ...(targets ? { targets } : {}),
      transport: "stdio",
      command,
      ...(args ? { args } : {}),
      ...(normalized.env ? { env: normalized.env } : {})
    };
    return { server, actionItems: normalized.actionItems };
  }

  if (url) {
    const transport = explicitTransport === "sse" || type === "sse" ? "sse" : "http";
    const server: McpServerConfig = {
      name,
      ...(targets ? { targets } : {}),
      transport,
      url,
      ...(normalized.headers ? { headers: normalized.headers } : {})
    };
    return { server, actionItems: normalized.actionItems };
  }

  return undefined;
}

function getMcpMap(json: unknown): Record<string, unknown> | undefined {
  if (!isRecord(json)) {
    return undefined;
  }

  if (isRecord(json.mcpServers)) {
    return json.mcpServers;
  }

  if (isRecord(json.mcp)) {
    return json.mcp;
  }

  return undefined;
}

interface DiscoveryRawItem {
  category: ConcreteImportCategory;
  item: ImportedItem;
  source: ImportSource;
  sourcePath: string;
  envActionItems: EnvActionItem[];
}

async function discoverJsonMcp(
  source: ImportSource,
  sourcePath: string,
  warnings: ImportWarning[],
  policy: EnvPolicy
): Promise<DiscoveryRawItem[]> {
  const json = await readJsonFile(sourcePath);
  if (json === undefined) {
    return [];
  }

  const mcpMap = getMcpMap(json);
  if (!mcpMap) {
    return [];
  }

  return Object.entries(mcpMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([name, raw]): DiscoveryRawItem[] => {
      const normalized = normalizeMcpServer(name, raw, source, sourcePath, warnings, policy);
      if (!normalized) {
        return [];
      }
      return [
        {
          category: "mcp",
          item: normalized.server,
          source,
          sourcePath,
          envActionItems: normalized.actionItems
        }
      ];
    });
}

async function discoverCommands(
  source: ImportSource,
  commandsDir: string
): Promise<DiscoveryRawItem[]> {
  const names = await safeReadDir(commandsDir);
  const items: DiscoveryRawItem[] = [];

  for (const fileName of names) {
    if (!fileName.endsWith(".md")) {
      continue;
    }

    const sourcePath = path.join(commandsDir, fileName);
    items.push({
      category: "commands",
      source,
      sourcePath,
      envActionItems: [],
      item: {
        name: path.basename(fileName, ".md"),
        prompt: await readFile(sourcePath, "utf8")
      }
    });
  }

  return items;
}

async function discoverSkills(
  source: ImportSource,
  skillsDir: string
): Promise<DiscoveryRawItem[]> {
  const names = await safeReadDir(skillsDir);
  const items: DiscoveryRawItem[] = [];

  for (const dirName of names) {
    const sourcePath = path.join(skillsDir, dirName, "SKILL.md");
    if (!(await fileExists(sourcePath))) {
      continue;
    }

    items.push({
      category: "skills",
      source,
      sourcePath,
      envActionItems: [],
      item: {
        name: dirName,
        description: `Imported ${source} skill ${dirName}`,
        content: await readFile(sourcePath, "utf8")
      }
    });
  }

  return items;
}

function stripTomlComment(line: string): string {
  let quote: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if ((char === '"' || char === "'") && line[index - 1] !== "\\") {
      quote = quote === char ? undefined : quote ?? char;
    }
    if (char === "#" && !quote) {
      return line.slice(0, index);
    }
  }
  return line;
}

function unquoteToml(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, "\n");
  }
  return trimmed;
}

function splitTomlList(value: string): string[] {
  const inner = value.trim().slice(1, -1).trim();
  if (!inner) {
    return [];
  }

  const items: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if ((char === '"' || char === "'") && inner[index - 1] !== "\\") {
      quote = quote === char ? undefined : quote ?? char;
    }
    if (char === "," && !quote) {
      items.push(unquoteToml(current));
      current = "";
      continue;
    }
    current += char;
  }
  items.push(unquoteToml(current));
  return items;
}

function parseTomlInlineTable(value: string): Record<string, string> {
  const inner = value.trim().slice(1, -1).trim();
  if (!inner) {
    return {};
  }

  const entries: Record<string, string> = {};
  for (const part of splitTomlList(`[${inner}]`)) {
    const equalsIndex = part.indexOf("=");
    if (equalsIndex === -1) {
      throw new Error(`Invalid inline table entry "${part}"`);
    }
    entries[unquoteToml(part.slice(0, equalsIndex).trim())] = unquoteToml(
      part.slice(equalsIndex + 1).trim()
    );
  }
  return entries;
}

function parseTomlValue(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return splitTomlList(trimmed);
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return parseTomlInlineTable(trimmed);
  }
  return unquoteToml(trimmed);
}

function parseCodexMcpToml(raw: string, filePath: string): Record<string, Record<string, unknown>> {
  const servers: Record<string, Record<string, unknown>> = {};
  let currentName: string | undefined;

  for (const [lineIndex, rawLine] of raw.split(/\r?\n/).entries()) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) {
      continue;
    }

    const sectionMatch = line.match(/^\[mcp_servers\.([^\]]+)\]$/);
    if (sectionMatch) {
      currentName = unquoteToml(sectionMatch[1]!.trim());
      servers[currentName] = servers[currentName] ?? {};
      continue;
    }

    if (line.startsWith("[")) {
      currentName = undefined;
      continue;
    }

    if (!currentName) {
      continue;
    }

    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) {
      throw new Error(`Invalid TOML at ${filePath}:${lineIndex + 1}. Expected key = value.`);
    }

    const key = line.slice(0, equalsIndex).trim();
    const value = line.slice(equalsIndex + 1).trim();
    try {
      servers[currentName][key] = parseTomlValue(value);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid TOML at ${filePath}:${lineIndex + 1}: ${message}.`);
    }
  }

  return servers;
}

async function discoverCodexMcp(
  sourcePath: string,
  warnings: ImportWarning[],
  policy: EnvPolicy
): Promise<DiscoveryRawItem[]> {
  if (!(await fileExists(sourcePath))) {
    return [];
  }

  let mcpMap: Record<string, Record<string, unknown>>;
  try {
    mcpMap = parseCodexMcpToml(await readFile(sourcePath, "utf8"), sourcePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid MCP TOML at ${sourcePath}: ${message} Fix the file or exclude mcp.`);
  }

  return Object.entries(mcpMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([name, raw]): DiscoveryRawItem[] => {
      const normalized = normalizeMcpServer(name, raw, "codex", sourcePath, warnings, policy);
      if (!normalized) {
        return [];
      }
      return [
        {
          category: "mcp",
          item: normalized.server,
          source: "codex",
          sourcePath,
          envActionItems: normalized.actionItems
        }
      ];
    });
}

function supportsCategory(source: ImportSource, category: ConcreteImportCategory): boolean {
  if (source === "cursor") {
    return category !== "skills";
  }
  if (source === "codex") {
    return category !== "commands";
  }
  return true;
}

export function expandImportCategories(categories: ImportCategory[]): ConcreteImportCategory[] {
  return categories.includes("all")
    ? [...CONCRETE_CATEGORIES]
    : CONCRETE_CATEGORIES.filter((category) => categories.includes(category));
}

async function discoverCategory(
  source: ImportSource,
  category: ConcreteImportCategory,
  sourceDir: string,
  warnings: ImportWarning[],
  policy: EnvPolicy
): Promise<DiscoveryRawItem[]> {
  if (category === "mcp") {
    if (source === "claude") {
      return discoverJsonMcp(source, path.join(sourceDir, ".mcp.json"), warnings, policy);
    }
    if (source === "cursor") {
      return discoverJsonMcp(source, path.join(sourceDir, ".cursor", "mcp.json"), warnings, policy);
    }
    if (source === "opencode") {
      return discoverJsonMcp(source, path.join(sourceDir, "opencode.json"), warnings, policy);
    }
    return discoverCodexMcp(path.join(sourceDir, ".codex", "config.toml"), warnings, policy);
  }

  if (category === "commands") {
    if (source === "claude") {
      return discoverCommands(source, path.join(sourceDir, ".claude", "commands"));
    }
    if (source === "cursor") {
      return discoverCommands(source, path.join(sourceDir, ".cursor", "commands"));
    }
    return discoverCommands(source, path.join(sourceDir, ".opencode", "commands"));
  }

  if (source === "claude") {
    return discoverSkills(source, path.join(sourceDir, ".claude", "skills"));
  }
  if (source === "opencode") {
    return discoverSkills(source, path.join(sourceDir, ".opencode", "skills"));
  }
  return discoverSkills(source, path.join(sourceDir, ".codex", "skills"));
}

function categoryToConfigKey(category: ConcreteImportCategory): ConfigCategory {
  if (category === "mcp") {
    return "mcpServers";
  }
  return category;
}

function getItemName(item: ImportedItem): string {
  return item.name;
}

interface McpRuntimeIdentity {
  transport: McpServerConfig["transport"];
  endpoint?: string;
  command?: string;
  args?: string[];
}

interface McpSecretShape {
  envKeys: string[];
  headerKeys: string[];
}

function normalizeHttpEndpoint(rawUrl: string | undefined): string {
  const value = (rawUrl ?? "").trim();
  if (!value) {
    return "";
  }

  try {
    const url = new URL(value);
    const protocol = url.protocol.toLowerCase();
    const hostname = url.hostname.toLowerCase();
    const auth =
      url.username || url.password ? `${url.username}${url.password ? `:${url.password}` : ""}@` : "";
    const port = url.port ? `:${url.port}` : "";
    let pathname = url.pathname || "/";
    if (!url.search && pathname.length > 1 && pathname.endsWith("/")) {
      pathname = pathname.replace(/\/+$/g, "");
    }

    return `${protocol}//${auth}${hostname}${port}${pathname}${url.search}`;
  } catch {
    return value;
  }
}

function getMcpRuntimeIdentity(server: McpServerConfig): McpRuntimeIdentity {
  if (server.transport === "stdio") {
    return {
      transport: server.transport,
      command: server.command ?? "",
      args: server.args ?? []
    };
  }

  return {
    transport: server.transport,
    endpoint: normalizeHttpEndpoint(server.url)
  };
}

function sortedRecordKeys(record: Record<string, string> | undefined, normalizeKey = false): string[] {
  return Object.keys(record ?? {})
    .map((key) => (normalizeKey ? key.toLowerCase() : key))
    .sort((a, b) => a.localeCompare(b));
}

function getMcpSecretShape(server: McpServerConfig): McpSecretShape {
  return {
    envKeys: sortedRecordKeys(server.env),
    headerKeys: sortedRecordKeys(server.headers, true)
  };
}

function stringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function mcpRuntimeIdentitiesEqual(left: McpRuntimeIdentity, right: McpRuntimeIdentity): boolean {
  if (left.transport !== right.transport) {
    return false;
  }

  if (left.transport === "stdio") {
    return left.command === right.command && stringArraysEqual(left.args ?? [], right.args ?? []);
  }

  return left.endpoint === right.endpoint;
}

function mcpSecretShapesEqual(left: McpSecretShape, right: McpSecretShape): boolean {
  return (
    stringArraysEqual(left.envKeys, right.envKeys) &&
    stringArraysEqual(left.headerKeys, right.headerKeys)
  );
}

function mcpRuntimeAndSecretShapeEqual(left: McpServerConfig, right: McpServerConfig): boolean {
  return (
    mcpRuntimeIdentitiesEqual(getMcpRuntimeIdentity(left), getMcpRuntimeIdentity(right)) &&
    mcpSecretShapesEqual(getMcpSecretShape(left), getMcpSecretShape(right))
  );
}

function getMcpDifferenceDimensions(left: McpServerConfig, right: McpServerConfig): string[] {
  const dimensions: string[] = [];
  const leftRuntime = getMcpRuntimeIdentity(left);
  const rightRuntime = getMcpRuntimeIdentity(right);
  const leftSecrets = getMcpSecretShape(left);
  const rightSecrets = getMcpSecretShape(right);

  if (leftRuntime.transport !== rightRuntime.transport) {
    dimensions.push("transport");
  } else if (leftRuntime.transport === "stdio") {
    if (leftRuntime.command !== rightRuntime.command) {
      dimensions.push("command");
    }
    if (!stringArraysEqual(leftRuntime.args ?? [], rightRuntime.args ?? [])) {
      dimensions.push("args");
    }
  } else if (leftRuntime.endpoint !== rightRuntime.endpoint) {
    dimensions.push("endpoint");
  }

  if (!stringArraysEqual(leftSecrets.envKeys, rightSecrets.envKeys)) {
    dimensions.push("env keys");
  }
  if (!stringArraysEqual(leftSecrets.headerKeys, rightSecrets.headerKeys)) {
    dimensions.push("header keys");
  }

  return dimensions.length > 0 ? dimensions : ["runtime identity"];
}

function describeMcpRuntimeMatch(server: McpServerConfig): string {
  if (server.transport === "stdio") {
    return "stdio command and ordered args";
  }

  return `${server.transport.toUpperCase()} endpoint`;
}

function plannedTargetMerge(existing: McpServerConfig, incoming: McpServerConfig): Target[] {
  if (!incoming.targets || incoming.targets.length === 0 || !existing.targets) {
    return [];
  }

  const seen = new Set<Target>(existing.targets);
  const additions: Target[] = [];
  for (const target of incoming.targets) {
    if (!seen.has(target)) {
      additions.push(target);
      seen.add(target);
    }
  }
  return additions;
}

function applyTargetMerge(existing: McpServerConfig, mergedTargets: Target[]): void {
  if (mergedTargets.length === 0 || !existing.targets) {
    return;
  }
  existing.targets = [...existing.targets, ...mergedTargets];
}

function equivalentItem(category: ConcreteImportCategory, left: ImportedItem, right: ImportedItem): boolean {
  if (category === "commands") {
    return (left as CommandConfig).prompt === (right as CommandConfig).prompt;
  }
  if (category === "skills") {
    return (left as SkillConfig).content === (right as SkillConfig).content;
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

function cloneConfig(config: AgentportConfig): AgentportConfig {
  return JSON.parse(JSON.stringify(config)) as AgentportConfig;
}

function emptyCounts(): Record<ConcreteImportCategory, ImportCounts> {
  return {
    mcp: { imported: 0, skipped: 0, unchanged: 0, conflicts: 0, warnings: 0 },
    skills: { imported: 0, skipped: 0, unchanged: 0, conflicts: 0, warnings: 0 },
    commands: { imported: 0, skipped: 0, unchanged: 0, conflicts: 0, warnings: 0 }
  };
}

function appendItemToConfig(config: AgentportConfig, category: ConcreteImportCategory, item: ImportedItem): void {
  const key = categoryToConfigKey(category);
  if (key === "mcpServers") {
    config.mcpServers = [...(config.mcpServers ?? []), item as McpServerConfig];
    return;
  }
  if (key === "skills") {
    config.skills = [...(config.skills ?? []), item as SkillConfig];
    return;
  }
  config.commands = [...(config.commands ?? []), item as CommandConfig];
}

function replaceItemInConfig(
  config: AgentportConfig,
  category: ConcreteImportCategory,
  name: string,
  next: ImportedItem
): void {
  const key = categoryToConfigKey(category);
  if (key === "mcpServers") {
    config.mcpServers = (config.mcpServers ?? []).map((item) =>
      item.name === name ? (next as McpServerConfig) : item
    );
    return;
  }
  if (key === "skills") {
    config.skills = (config.skills ?? []).map((item) =>
      item.name === name ? (next as SkillConfig) : item
    );
    return;
  }
  config.commands = (config.commands ?? []).map((item) =>
    item.name === name ? (next as CommandConfig) : item
  );
}

function getExistingItems(config: AgentportConfig, category: ConcreteImportCategory): ImportedItem[] {
  if (category === "mcp") {
    return config.mcpServers ?? [];
  }
  if (category === "skills") {
    return config.skills ?? [];
  }
  return config.commands ?? [];
}

function findPossibleMcpDuplicates(
  baseConfig: AgentportConfig,
  incoming: McpServerConfig,
  sourcePath: string
): ImportPossibleDuplicate[] {
  return (baseConfig.mcpServers ?? [])
    .filter((existing) => existing.name !== incoming.name)
    .filter((existing) => mcpRuntimeAndSecretShapeEqual(existing, incoming))
    .map((existing) => ({
      category: "mcp" as const,
      importedName: incoming.name,
      existingName: existing.name,
      sourcePath,
      message: `Possible duplicate MCP server "${incoming.name}" from ${sourcePath} matches existing "${existing.name}" by ${describeMcpRuntimeMatch(incoming)} and secret key shape`
    }));
}

async function loadOrCreateConfig(configPath: string): Promise<AgentportConfig> {
  return (await fileExists(configPath)) ? await loadConfig(configPath) : { version: 1 };
}

export function summarizeMcpRedacted(server: McpServerConfig): string {
  const parts: string[] = [`transport=${server.transport}`];
  if (server.transport === "stdio") {
    parts.push(`command=${server.command ?? ""}`);
    if (server.args && server.args.length > 0) {
      parts.push(`args=[${server.args.map((arg) => JSON.stringify(arg)).join(", ")}]`);
    }
  } else {
    parts.push(`url=${server.url ?? ""}`);
  }
  if (server.targets && server.targets.length > 0) {
    parts.push(`targets=[${server.targets.join(", ")}]`);
  }
  if (server.env) {
    const envSummary = Object.entries(server.env)
      .map(([key, value]) => `${key}=${redactValue(value)}`)
      .join(", ");
    parts.push(`env={${envSummary}}`);
  }
  if (server.headers) {
    const headerSummary = Object.entries(server.headers)
      .map(([key, value]) => `${key}=${redactValue(value)}`)
      .join(", ");
    parts.push(`headers={${headerSummary}}`);
  }
  return parts.join(" ");
}

export function summarizeItemRedacted(category: ConcreteImportCategory, item: ImportedItem): string {
  if (category === "mcp") {
    return summarizeMcpRedacted(item as McpServerConfig);
  }
  if (category === "skills") {
    const skill = item as SkillConfig;
    const length = (skill.content ?? "").length;
    return `name=${skill.name} description="${skill.description ?? ""}" content(${length} chars)`;
  }
  const command = item as CommandConfig;
  const length = (command.prompt ?? "").length;
  return `name=${command.name} prompt(${length} chars)`;
}

function classifyAgainst(
  category: ConcreteImportCategory,
  incoming: ImportedItem,
  existing: ImportedItem,
  conflictSource: ConflictSource
): CandidateClassification {
  if (category === "mcp") {
    const existingMcp = existing as McpServerConfig;
    const incomingMcp = incoming as McpServerConfig;
    if (mcpRuntimeAndSecretShapeEqual(existingMcp, incomingMcp)) {
      const mergedTargets = plannedTargetMerge(existingMcp, incomingMcp);
      if (mergedTargets.length > 0) {
        return { kind: "merge", mergedTargets };
      }
      return { kind: "unchanged" };
    }

    const dimensions = getMcpDifferenceDimensions(existingMcp, incomingMcp);
    return {
      kind: "conflict",
      differenceDimensions: dimensions,
      safeMergeAvailable: false,
      conflictSource,
      existing: existingMcp,
      existingSummary: summarizeMcpRedacted(existingMcp),
      incomingSummary: summarizeMcpRedacted(incomingMcp)
    };
  }

  if (equivalentItem(category, existing, incoming)) {
    return { kind: "unchanged" };
  }

  return {
    kind: "conflict",
    differenceDimensions: ["content"],
    safeMergeAvailable: false,
    conflictSource,
    existing,
    existingSummary: summarizeItemRedacted(category, existing),
    incomingSummary: summarizeItemRedacted(category, incoming)
  };
}

function classifyCandidate(
  baseConfig: AgentportConfig,
  earlier: DiscoveredItem[],
  raw: DiscoveryRawItem
): {
  classification: CandidateClassification;
  possibleDuplicates: ImportPossibleDuplicate[];
} {
  const existing = getExistingItems(baseConfig, raw.category).find(
    (candidate) => getItemName(candidate) === getItemName(raw.item)
  );

  if (existing) {
    return {
      classification: classifyAgainst(raw.category, raw.item, existing, "base-config"),
      possibleDuplicates: []
    };
  }

  const earlierMatch = earlier.find(
    (candidate) =>
      candidate.category === raw.category &&
      getItemName(candidate.item) === getItemName(raw.item) &&
      candidate.classification.kind !== "conflict"
  );

  if (earlierMatch) {
    return {
      classification: classifyAgainst(raw.category, raw.item, earlierMatch.item, "earlier-candidate"),
      possibleDuplicates: []
    };
  }

  const possibleDuplicates: ImportPossibleDuplicate[] = [];
  if (raw.category === "mcp") {
    const incoming = raw.item as McpServerConfig;
    possibleDuplicates.push(
      ...findPossibleMcpDuplicates(baseConfig, incoming, raw.sourcePath)
    );

    for (const previous of earlier) {
      if (previous.category !== "mcp") {
        continue;
      }
      if (previous.classification.kind !== "new") {
        continue;
      }
      const previousMcp = previous.item as McpServerConfig;
      if (previousMcp.name === incoming.name) {
        continue;
      }
      if (!mcpRuntimeAndSecretShapeEqual(previousMcp, incoming)) {
        continue;
      }
      possibleDuplicates.push({
        category: "mcp",
        importedName: incoming.name,
        existingName: previousMcp.name,
        sourcePath: raw.sourcePath,
        message: `Possible duplicate MCP server "${incoming.name}" from ${raw.sourcePath} matches earlier "${previousMcp.name}" by ${describeMcpRuntimeMatch(incoming)} and secret key shape`
      });
    }
  }
  return { classification: { kind: "new" }, possibleDuplicates };
}

function buildCandidateId(raw: DiscoveryRawItem): string {
  return `${raw.category}:${raw.source}:${getItemName(raw.item)}`;
}

export async function planImport(options: ImportOptions): Promise<ImportPlan> {
  const categories = expandImportCategories(options.categories);
  const policy = options.envPolicy ?? NON_INTERACTIVE_ENV_POLICY;
  const discovery: ImportDiscoveryStatus[] = [];
  const skipped: ImportSkip[] = [];
  const warnings: ImportWarning[] = [];
  const rawItems: DiscoveryRawItem[] = [];

  for (const source of options.sources) {
    for (const category of categories) {
      if (!supportsCategory(source, category)) {
        const reason = `${source} ${category} import is not supported`;
        discovery.push({ source, category, supported: false, discovered: 0, reason });
        skipped.push({ source, category, reason });
        continue;
      }

      const items = await discoverCategory(source, category, options.sourceDir, warnings, policy);
      discovery.push({ source, category, supported: true, discovered: items.length });
      rawItems.push(...items);
    }
  }

  const baseConfig = await loadOrCreateConfig(options.configPath);
  const candidates: DiscoveredItem[] = [];
  const envActionItems: EnvActionItem[] = [];

  for (const raw of rawItems) {
    const { classification, possibleDuplicates } = classifyCandidate(baseConfig, candidates, raw);
    candidates.push({
      id: buildCandidateId(raw),
      category: raw.category,
      item: raw.item,
      source: raw.source,
      sourcePath: raw.sourcePath,
      classification,
      possibleDuplicates,
      envActionItems: raw.envActionItems
    });
    envActionItems.push(...raw.envActionItems);
  }

  return {
    configPath: options.configPath,
    sourceDir: options.sourceDir,
    sources: options.sources,
    categories,
    baseConfig,
    candidates,
    discovery,
    skipped,
    warnings,
    envActionItems,
    envPolicy: policy
  };
}

function defaultSelection(plan: ImportPlan): ResolvedSelection {
  const selectedIds = new Set<string>();
  const conflictActions = new Map<string, ConflictAction>();
  for (const candidate of plan.candidates) {
    selectedIds.add(candidate.id);
  }
  return { selectedIds, conflictActions };
}

function ensureUniqueRename(
  category: ConcreteImportCategory,
  newName: string,
  workingConfig: AgentportConfig
): void {
  const existingNames = new Set(getExistingItems(workingConfig, category).map((item) => item.name));
  if (existingNames.has(newName)) {
    throw new Error(
      `Renamed ${category} item "${newName}" conflicts with an existing ${category} item; choose a different name.`
    );
  }
}

function overrideKey(candidateId: string, fieldKind: "env" | "header", fieldKey: string): string {
  return `${candidateId}::${fieldKind}:${fieldKey}`;
}

function buildOverrideMap(overrides: EnvOverride[] | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const override of overrides ?? []) {
    map.set(overrideKey(override.candidateId, override.fieldKind, override.fieldKey), override.envVar);
  }
  return map;
}

function rewritePlaceholderValue(value: string, newEnvVar: string): string {
  const trimmed = value.trim();
  const bearerMatch = trimmed.match(/^Bearer\s+\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/);
  if (bearerMatch) {
    return `Bearer {env:${newEnvVar}}`;
  }
  if (/^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.test(trimmed)) {
    return `{env:${newEnvVar}}`;
  }
  return value;
}

function applyOverridesToServer(
  server: McpServerConfig,
  candidateId: string,
  overrides: Map<string, string>
): McpServerConfig {
  if (overrides.size === 0) {
    return server;
  }

  const next: McpServerConfig = { ...server };

  if (server.env) {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(server.env)) {
      const override = overrides.get(overrideKey(candidateId, "env", key));
      env[key] = override ? rewritePlaceholderValue(value, override) : value;
    }
    next.env = env;
  }

  if (server.headers) {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(server.headers)) {
      const override = overrides.get(overrideKey(candidateId, "header", key));
      headers[key] = override ? rewritePlaceholderValue(value, override) : value;
    }
    next.headers = headers;
  }

  return next;
}

function rewriteActionItemsForOverrides(
  candidateId: string,
  actionItems: EnvActionItem[],
  overrides: Map<string, string>
): EnvActionItem[] {
  if (overrides.size === 0) {
    return actionItems;
  }

  return actionItems.map((item) => {
    const override = overrides.get(overrideKey(candidateId, item.field.kind, item.field.key));
    if (!override || override === item.envVar) {
      return item;
    }
    return {
      ...item,
      envVar: override,
      message: item.message.replace(item.envVar, override)
    };
  });
}

export async function applyImportPlan(options: ApplyImportOptions): Promise<ImportResult> {
  const plan = options.plan;
  const dryRun = Boolean(options.dryRun);
  const selection = options.selection ?? defaultSelection(plan);
  const mergedConfig = cloneConfig(plan.baseConfig);
  const overrideMap = buildOverrideMap(selection.envOverrides);

  const imported: DiscoveredItem[] = [];
  const unchanged: DiscoveredItem[] = [];
  const merged: ImportMerge[] = [];
  const conflicts: ImportConflict[] = [];
  const possibleDuplicates: ImportPossibleDuplicate[] = [];
  const finalActionItems: EnvActionItem[] = [];
  let aborted = false;

  const recordImported = (candidate: DiscoveredItem, writtenItem: ImportedItem): void => {
    imported.push({ ...candidate, item: writtenItem });
    if (candidate.category === "mcp" && candidate.envActionItems.length > 0) {
      finalActionItems.push(
        ...rewriteActionItemsForOverrides(candidate.id, candidate.envActionItems, overrideMap)
      );
    }
  };

  const transformedItem = (candidate: DiscoveredItem): ImportedItem => {
    if (candidate.category !== "mcp") {
      return candidate.item;
    }
    return applyOverridesToServer(candidate.item as McpServerConfig, candidate.id, overrideMap);
  };

  for (const candidate of plan.candidates) {
    const isSelected = selection.selectedIds.has(candidate.id);

    if (candidate.classification.kind === "new") {
      if (!isSelected) {
        continue;
      }
      const item = transformedItem(candidate);
      appendItemToConfig(mergedConfig, candidate.category, item);
      recordImported(candidate, item);
      continue;
    }

    if (candidate.classification.kind === "merge") {
      if (!isSelected) {
        continue;
      }
      const existing = getExistingItems(mergedConfig, candidate.category).find(
        (item) => item.name === candidate.item.name
      ) as McpServerConfig | undefined;
      if (existing) {
        applyTargetMerge(existing, candidate.classification.mergedTargets);
      }
      merged.push({
        category: "mcp",
        name: candidate.item.name,
        sourcePath: candidate.sourcePath,
        mergedTargets: candidate.classification.mergedTargets,
        message: `Merged MCP server "${candidate.item.name}" target eligibility from ${candidate.sourcePath}: ${candidate.classification.mergedTargets.join(", ")}`
      });
      continue;
    }

    if (candidate.classification.kind === "unchanged") {
      unchanged.push(candidate);
      continue;
    }

    if (!isSelected) {
      continue;
    }

    const conflictAction = selection.conflictActions.get(candidate.id);
    if (!conflictAction) {
      conflicts.push({
        category: candidate.category,
        name: candidate.item.name,
        sourcePath: candidate.sourcePath,
        message:
          candidate.category === "mcp"
            ? `Conflicting MCP server "${candidate.item.name}" from ${candidate.sourcePath} differs by ${candidate.classification.differenceDimensions.join(", ")}`
            : `Conflicting ${candidate.category} item "${candidate.item.name}" from ${candidate.sourcePath}`
      });
      continue;
    }

    if (conflictAction.type === "abort") {
      aborted = true;
      break;
    }

    if (conflictAction.type === "keep" || conflictAction.type === "skip") {
      continue;
    }

    if (conflictAction.type === "replace") {
      const item = transformedItem(candidate);
      const targetName =
        candidate.classification.conflictSource === "earlier-candidate"
          ? candidate.classification.existing.name
          : candidate.item.name;
      replaceItemInConfig(mergedConfig, candidate.category, targetName, item);
      if (candidate.classification.conflictSource === "earlier-candidate") {
        const replacedIndex = imported.findIndex(
          (entry) => entry.category === candidate.category && entry.item.name === targetName
        );
        if (replacedIndex !== -1) {
          const removed = imported.splice(replacedIndex, 1)[0];
          if (removed) {
            for (let i = finalActionItems.length - 1; i >= 0; i -= 1) {
              if (finalActionItems[i]!.itemName === removed.item.name) {
                finalActionItems.splice(i, 1);
              }
            }
          }
        }
      }
      recordImported(candidate, item);
      continue;
    }

    if (conflictAction.type === "rename") {
      ensureUniqueRename(candidate.category, conflictAction.newName, mergedConfig);
      const baseItem = transformedItem(candidate);
      const renamedItem: ImportedItem = { ...baseItem, name: conflictAction.newName };
      appendItemToConfig(mergedConfig, candidate.category, renamedItem);
      recordImported(candidate, renamedItem);
      continue;
    }

    if (conflictAction.type === "merge") {
      if (!candidate.classification.safeMergeAvailable || candidate.category !== "mcp") {
        conflicts.push({
          category: candidate.category,
          name: candidate.item.name,
          sourcePath: candidate.sourcePath,
          message: `No safe merge available for ${candidate.category} "${candidate.item.name}" from ${candidate.sourcePath}; pick keep, replace, rename, or abort.`
        });
        continue;
      }
    }
  }

  if (!aborted) {
    const baseMcpNames = new Set(
      (plan.baseConfig.mcpServers ?? []).map((server) => server.name)
    );
    const importedMcpRank = new Map<string, number>();
    let rank = 0;
    for (const candidate of imported) {
      if (candidate.category === "mcp") {
        importedMcpRank.set(candidate.item.name, rank);
        rank += 1;
      }
    }

    const finalMcpServers = mergedConfig.mcpServers ?? [];
    for (const candidate of imported) {
      if (candidate.category !== "mcp") {
        continue;
      }
      const incoming = candidate.item as McpServerConfig;
      const myRank = importedMcpRank.get(incoming.name) ?? -1;
      for (const existing of finalMcpServers) {
        if (existing.name === incoming.name) {
          continue;
        }
        if (!mcpRuntimeAndSecretShapeEqual(existing, incoming)) {
          continue;
        }
        const otherIsBase = baseMcpNames.has(existing.name);
        const otherRank = importedMcpRank.get(existing.name);
        const includePair =
          otherIsBase || (otherRank !== undefined && otherRank < myRank);
        if (!includePair) {
          continue;
        }
        possibleDuplicates.push({
          category: "mcp",
          importedName: incoming.name,
          existingName: existing.name,
          sourcePath: candidate.sourcePath,
          message: `Possible duplicate MCP server "${incoming.name}" from ${candidate.sourcePath} matches existing "${existing.name}" by ${describeMcpRuntimeMatch(incoming)} and secret key shape`
        });
      }
    }
  }

  const countsByCategory = emptyCounts();
  for (const item of imported) countsByCategory[item.category].imported += 1;
  for (const item of plan.skipped) countsByCategory[item.category].skipped += 1;
  for (const item of unchanged) countsByCategory[item.category].unchanged += 1;
  for (const item of conflicts) countsByCategory[item.category].conflicts += 1;
  for (const item of plan.warnings) countsByCategory[item.category].warnings += 1;

  const configChanged = !aborted && (imported.length > 0 || merged.length > 0);
  const configWritten = configChanged && conflicts.length === 0 && !dryRun;

  if (configWritten) {
    await mkdir(path.dirname(plan.configPath), { recursive: true });
    await writeFile(plan.configPath, YAML.stringify(mergedConfig), "utf8");
  }

  return {
    configPath: plan.configPath,
    sourceDir: plan.sourceDir,
    sources: plan.sources,
    categories: plan.categories,
    imported,
    discovery: plan.discovery,
    skipped: plan.skipped,
    unchanged,
    merged,
    conflicts,
    possibleDuplicates,
    warnings: plan.warnings,
    envActionItems: finalActionItems,
    countsByCategory,
    configWritten,
    configChanged,
    dryRun,
    aborted,
    mergedConfig
  };
}

export async function importProject(options: ImportOptions): Promise<ImportResult> {
  const plan = await planImport(options);
  return applyImportPlan({ plan, dryRun: options.dryRun });
}

export function assertValidImportSources(values: string[]): ImportSource[] {
  if (values.length === 0) {
    throw new Error(
      `Missing --from. Pass one or more sources: ${IMPORT_SOURCES.join(", ")}. ${HELP_HINT}`
    );
  }

  for (const value of values) {
    if (!IMPORT_SOURCES.includes(value as ImportSource)) {
      throw new Error(
        `Unsupported import source "${value}". Supported sources: ${IMPORT_SOURCES.join(", ")}. ${HELP_HINT}`
      );
    }
  }

  return values as ImportSource[];
}

export function assertValidImportCategories(values: string[]): ImportCategory[] {
  if (values.length === 0) {
    throw new Error(
      `Missing --include. Pass one or more categories: ${IMPORT_CATEGORIES.join(", ")}. ${HELP_HINT}`
    );
  }

  for (const value of values) {
    if (!IMPORT_CATEGORIES.includes(value as ImportCategory)) {
      throw new Error(
        `Unsupported import category "${value}". Supported categories: ${IMPORT_CATEGORIES.join(", ")}. ${HELP_HINT}`
      );
    }
  }

  return values as ImportCategory[];
}

export { applyEnvPolicyToServer };
