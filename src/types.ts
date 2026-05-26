export const TARGETS = ["claude", "codex", "cursor", "opencode"] as const;
export const IMPORT_SOURCES = ["claude", "cursor", "opencode", "codex"] as const;
export const IMPORT_CATEGORIES = ["mcp", "skills", "commands", "all"] as const;

export type Target = (typeof TARGETS)[number];
export type ImportSource = (typeof IMPORT_SOURCES)[number];
export type ImportCategory = (typeof IMPORT_CATEGORIES)[number];
export type ConcreteImportCategory = Exclude<ImportCategory, "all">;

export interface ProjectMeta {
  name?: string;
}

export interface InstructionsConfig {
  shared?: string[];
  byTarget?: Partial<Record<Target, string[]>>;
}

export interface CursorRuleConfig {
  mode?: "always" | "auto" | "agent_requested";
  globs?: string[];
}

export interface RuleConfig {
  name: string;
  description?: string;
  targets?: Target[];
  content: string;
  cursor?: CursorRuleConfig;
}

export interface CommandConfig {
  name: string;
  description?: string;
  targets?: Target[];
  prompt: string;
}

export interface SkillConfig {
  name: string;
  description: string;
  targets?: Target[];
  content: string;
}

export interface McpServerConfig {
  name: string;
  targets?: Target[];
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface ProfileConfig {
  name: string;
  description?: string;
  targets?: Target[];
  rules?: string[];
  commands?: string[];
  skills?: string[];
  mcpServers?: string[];
}

export interface AgentportConfig {
  version: 1;
  project?: ProjectMeta;
  instructions?: InstructionsConfig;
  rules?: RuleConfig[];
  commands?: CommandConfig[];
  skills?: SkillConfig[];
  mcpServers?: McpServerConfig[];
  profiles?: ProfileConfig[];
}

export interface BuildOptions {
  configPath: string;
  outDir: string;
  targets?: Target[];
  profile?: string;
  allTargets?: boolean;
  dryRun?: boolean;
  stdout?: boolean;
}

export interface BuildWarning {
  target: Target;
  message: string;
}
