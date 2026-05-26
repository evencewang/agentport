import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

import { loadConfig } from "./config.js";
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

export interface DiscoveredItem {
  category: ConcreteImportCategory;
  item: ImportedItem;
  source: ImportSource;
  sourcePath: string;
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
  countsByCategory: Record<ConcreteImportCategory, ImportCounts>;
  configWritten: boolean;
  configChanged: boolean;
  dryRun: boolean;
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

function normalizeMcpServer(
  name: string,
  raw: unknown,
  source: ImportSource,
  sourcePath: string,
  warnings: ImportWarning[]
): McpServerConfig | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const env = asStringRecord(raw.env);
  const headers = asStringRecord(raw.headers) ?? asStringRecord(raw.http_headers);
  const envHttpHeaders = asStringRecord(raw.env_http_headers);
  const commandArray = asStringArray(raw.command);
  const command = commandArray ? commandArray[0] : typeof raw.command === "string" ? raw.command : undefined;
  const args = commandArray ? commandArray.slice(1) : asStringArray(raw.args);
  const url = typeof raw.url === "string" ? raw.url : undefined;
  const targets = asTargets(raw.targets);
  const type = typeof raw.type === "string" ? raw.type : undefined;
  const explicitTransport = typeof raw.transport === "string" ? raw.transport : undefined;

  if (env || headers || envHttpHeaders || Object.keys(raw).some((key) => key.includes("bearer"))) {
    warnings.push({
      source,
      category: "mcp",
      name,
      sourcePath,
      message: `MCP server "${name}" imports env/header-like values; review ${sourcePath} before committing.`
    });
  }

  if (command) {
    return {
      name,
      ...(targets ? { targets } : {}),
      transport: "stdio",
      command,
      ...(args ? { args } : {}),
      ...(env ? { env } : {})
    };
  }

  if (url) {
    const transport = explicitTransport === "sse" || type === "sse" ? "sse" : "http";
    return {
      name,
      ...(targets ? { targets } : {}),
      transport,
      url,
      ...(headers ?? envHttpHeaders ? { headers: { ...(headers ?? {}), ...(envHttpHeaders ?? {}) } } : {})
    };
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

async function discoverJsonMcp(
  source: ImportSource,
  sourcePath: string,
  warnings: ImportWarning[]
): Promise<DiscoveredItem[]> {
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
    .flatMap(([name, raw]) => {
      const item = normalizeMcpServer(name, raw, source, sourcePath, warnings);
      return item ? [{ category: "mcp" as const, item, source, sourcePath }] : [];
    });
}

async function discoverCommands(
  source: ImportSource,
  commandsDir: string
): Promise<DiscoveredItem[]> {
  const names = await safeReadDir(commandsDir);
  const items: DiscoveredItem[] = [];

  for (const fileName of names) {
    if (!fileName.endsWith(".md")) {
      continue;
    }

    const sourcePath = path.join(commandsDir, fileName);
    items.push({
      category: "commands",
      source,
      sourcePath,
      item: {
        name: path.basename(fileName, ".md"),
        prompt: await readFile(sourcePath, "utf8")
      }
    });
  }

  return items;
}

async function discoverSkills(source: ImportSource, skillsDir: string): Promise<DiscoveredItem[]> {
  const names = await safeReadDir(skillsDir);
  const items: DiscoveredItem[] = [];

  for (const dirName of names) {
    const sourcePath = path.join(skillsDir, dirName, "SKILL.md");
    if (!(await fileExists(sourcePath))) {
      continue;
    }

    items.push({
      category: "skills",
      source,
      sourcePath,
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
  warnings: ImportWarning[]
): Promise<DiscoveredItem[]> {
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
    .flatMap(([name, raw]) => {
      const item = normalizeMcpServer(name, raw, "codex", sourcePath, warnings);
      return item ? [{ category: "mcp" as const, item, source: "codex" as const, sourcePath }] : [];
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
  warnings: ImportWarning[]
): Promise<DiscoveredItem[]> {
  if (category === "mcp") {
    if (source === "claude") {
      return discoverJsonMcp(source, path.join(sourceDir, ".mcp.json"), warnings);
    }
    if (source === "cursor") {
      return discoverJsonMcp(source, path.join(sourceDir, ".cursor", "mcp.json"), warnings);
    }
    if (source === "opencode") {
      return discoverJsonMcp(source, path.join(sourceDir, "opencode.json"), warnings);
    }
    return discoverCodexMcp(path.join(sourceDir, ".codex", "config.toml"), warnings);
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

function mergeMcpTargets(existing: McpServerConfig, incoming: McpServerConfig): Target[] {
  if (!incoming.targets || incoming.targets.length === 0 || !existing.targets) {
    return [];
  }

  const mergedTargets = [...existing.targets];
  const seen = new Set<Target>(mergedTargets);
  const addedTargets: Target[] = [];

  for (const target of incoming.targets) {
    if (!seen.has(target)) {
      mergedTargets.push(target);
      addedTargets.push(target);
      seen.add(target);
    }
  }

  if (addedTargets.length > 0) {
    existing.targets = mergedTargets;
  }

  return addedTargets;
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

function addImportedItem(config: AgentportConfig, discovered: DiscoveredItem): void {
  const key = categoryToConfigKey(discovered.category);
  if (key === "mcpServers") {
    config.mcpServers = [...(config.mcpServers ?? []), discovered.item as McpServerConfig];
    return;
  }
  if (key === "skills") {
    config.skills = [...(config.skills ?? []), discovered.item as SkillConfig];
    return;
  }
  config.commands = [...(config.commands ?? []), discovered.item as CommandConfig];
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
  config: AgentportConfig,
  discovered: DiscoveredItem
): ImportPossibleDuplicate[] {
  const incoming = discovered.item as McpServerConfig;

  return (config.mcpServers ?? [])
    .filter((existing) => existing.name !== incoming.name)
    .filter((existing) => mcpRuntimeAndSecretShapeEqual(existing, incoming))
    .map((existing) => ({
      category: "mcp" as const,
      importedName: incoming.name,
      existingName: existing.name,
      sourcePath: discovered.sourcePath,
      message: `Possible duplicate MCP server "${incoming.name}" from ${discovered.sourcePath} matches existing "${existing.name}" by ${describeMcpRuntimeMatch(incoming)} and secret key shape`
    }));
}

async function loadOrCreateConfig(configPath: string): Promise<AgentportConfig> {
  return (await fileExists(configPath)) ? await loadConfig(configPath) : { version: 1 };
}

export async function importProject(options: ImportOptions): Promise<ImportResult> {
  const categories = expandImportCategories(options.categories);
  const discovery: ImportDiscoveryStatus[] = [];
  const skipped: ImportSkip[] = [];
  const warnings: ImportWarning[] = [];
  const discovered: DiscoveredItem[] = [];

  for (const source of options.sources) {
    for (const category of categories) {
      if (!supportsCategory(source, category)) {
        const reason = `${source} ${category} import is not supported`;
        discovery.push({ source, category, supported: false, discovered: 0, reason });
        skipped.push({ source, category, reason });
        continue;
      }

      const items = await discoverCategory(source, category, options.sourceDir, warnings);
      discovery.push({ source, category, supported: true, discovered: items.length });
      discovered.push(...items);
    }
  }

  const baseConfig = await loadOrCreateConfig(options.configPath);
  const mergedConfig = cloneConfig(baseConfig);
  const imported: DiscoveredItem[] = [];
  const unchanged: DiscoveredItem[] = [];
  const merged: ImportMerge[] = [];
  const conflicts: ImportConflict[] = [];
  const possibleDuplicates: ImportPossibleDuplicate[] = [];

  for (const item of discovered) {
    const existing = getExistingItems(mergedConfig, item.category).find(
      (candidate) => getItemName(candidate) === getItemName(item.item)
    );

    if (!existing) {
      if (item.category === "mcp") {
        possibleDuplicates.push(...findPossibleMcpDuplicates(mergedConfig, item));
      }
      addImportedItem(mergedConfig, item);
      imported.push(item);
      continue;
    }

    if (item.category === "mcp") {
      const existingMcp = existing as McpServerConfig;
      const incomingMcp = item.item as McpServerConfig;
      if (mcpRuntimeAndSecretShapeEqual(existingMcp, incomingMcp)) {
        const mergedTargets = mergeMcpTargets(existingMcp, incomingMcp);
        if (mergedTargets.length > 0) {
          merged.push({
            category: "mcp",
            name: incomingMcp.name,
            sourcePath: item.sourcePath,
            mergedTargets,
            message: `Merged MCP server "${incomingMcp.name}" target eligibility from ${item.sourcePath}: ${mergedTargets.join(", ")}`
          });
        } else {
          unchanged.push(item);
        }
        continue;
      }

      const dimensions = getMcpDifferenceDimensions(existingMcp, incomingMcp);
      conflicts.push({
        category: item.category,
        name: getItemName(item.item),
        sourcePath: item.sourcePath,
        message: `Conflicting MCP server "${getItemName(item.item)}" from ${item.sourcePath} differs by ${dimensions.join(", ")}`
      });
      continue;
    }

    if (equivalentItem(item.category, existing, item.item)) {
      unchanged.push(item);
      continue;
    }

    conflicts.push({
      category: item.category,
      name: getItemName(item.item),
      sourcePath: item.sourcePath,
      message: `Conflicting ${item.category} item "${getItemName(item.item)}" from ${item.sourcePath}`
    });
  }

  const countsByCategory = emptyCounts();
  for (const item of imported) countsByCategory[item.category].imported += 1;
  for (const item of skipped) countsByCategory[item.category].skipped += 1;
  for (const item of unchanged) countsByCategory[item.category].unchanged += 1;
  for (const item of conflicts) countsByCategory[item.category].conflicts += 1;
  for (const item of warnings) countsByCategory[item.category].warnings += 1;

  const configChanged = imported.length > 0 || merged.length > 0;
  const configWritten = configChanged && conflicts.length === 0 && !options.dryRun;

  if (conflicts.length === 0 && configWritten) {
    await mkdir(path.dirname(options.configPath), { recursive: true });
    await writeFile(options.configPath, YAML.stringify(mergedConfig), "utf8");
  }

  return {
    configPath: options.configPath,
    sourceDir: options.sourceDir,
    sources: options.sources,
    categories,
    imported,
    discovery,
    skipped,
    unchanged,
    merged,
    conflicts,
    possibleDuplicates,
    warnings,
    countsByCategory,
    configWritten,
    configChanged,
    dryRun: Boolean(options.dryRun),
    mergedConfig
  };
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
