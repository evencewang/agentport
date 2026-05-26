import { readFile } from "node:fs/promises";
import YAML from "yaml";

import {
  TARGETS,
  type AgentportConfig,
  type InstructionsConfig,
  type ProfileConfig,
  type Target
} from "./types.js";

const PROFILE_SELECTION_KEYS = ["rules", "commands", "skills", "mcpServers"] as const;

type ProfileSelectionKey = (typeof PROFILE_SELECTION_KEYS)[number];
type NamedConfigItem = { name: string };

export interface ResolveConfigOptions {
  profile?: string;
  targets?: Target[];
  allTargets?: boolean;
}

export interface ResolvedConfig {
  config: AgentportConfig;
  targets: Target[];
  profile?: ProfileConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ensureStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }

  return value;
}

function ensureTargets(value: unknown, label: string): Target[] {
  const items = ensureStringArray(value, label);
  for (const item of items) {
    if (!TARGETS.includes(item as Target)) {
      throw new Error(`${label} contains unsupported target "${item}"`);
    }
  }

  return items as Target[];
}

function getSelectableItems(
  config: AgentportConfig,
  category: ProfileSelectionKey
): NamedConfigItem[] {
  return (config[category] ?? []) as NamedConfigItem[];
}

function findDuplicateName(items: NamedConfigItem[]): string | undefined {
  const seen = new Set<string>();

  for (const item of items) {
    if (seen.has(item.name)) {
      return item.name;
    }

    seen.add(item.name);
  }

  return undefined;
}

function validateProfileReferences(config: AgentportConfig): void {
  const profiles = config.profiles ?? [];
  const profileNames = new Set<string>();

  for (const profile of profiles) {
    if (profileNames.has(profile.name)) {
      throw new Error(`Duplicate profile name "${profile.name}"`);
    }
    profileNames.add(profile.name);

    for (const category of PROFILE_SELECTION_KEYS) {
      const selection = profile[category];
      if (selection === undefined) {
        continue;
      }

      const items = getSelectableItems(config, category);
      const duplicateName = findDuplicateName(items);
      if (duplicateName) {
        throw new Error(
          `Profile "${profile.name}" cannot select ${category} because item name "${duplicateName}" is duplicated`
        );
      }

      const knownNames = new Set(items.map((item) => item.name));
      for (const selectedName of selection) {
        if (!knownNames.has(selectedName)) {
          throw new Error(
            `Profile "${profile.name}" references unknown ${category} item "${selectedName}"`
          );
        }
      }
    }
  }
}

function cloneInstructions(instructions: InstructionsConfig): InstructionsConfig {
  return {
    ...(instructions.shared ? { shared: [...instructions.shared] } : {}),
    ...(instructions.byTarget
      ? {
          byTarget: Object.fromEntries(
            Object.entries(instructions.byTarget).map(([target, items]) => [
              target,
              items ? [...items] : items
            ])
          ) as Partial<Record<Target, string[]>>
        }
      : {})
  };
}

function cloneProfile(profile: ProfileConfig): ProfileConfig {
  return {
    ...profile,
    ...(profile.targets ? { targets: [...profile.targets] } : {}),
    ...(profile.rules ? { rules: [...profile.rules] } : {}),
    ...(profile.commands ? { commands: [...profile.commands] } : {}),
    ...(profile.skills ? { skills: [...profile.skills] } : {}),
    ...(profile.mcpServers ? { mcpServers: [...profile.mcpServers] } : {})
  };
}

function cloneConfig(config: AgentportConfig): AgentportConfig {
  return {
    version: config.version,
    ...(config.project ? { project: { ...config.project } } : {}),
    ...(config.instructions ? { instructions: cloneInstructions(config.instructions) } : {}),
    ...(config.rules
      ? {
          rules: config.rules.map((item) => ({
            ...item,
            ...(item.targets ? { targets: [...item.targets] } : {}),
            ...(item.cursor
              ? {
                  cursor: {
                    ...item.cursor,
                    ...(item.cursor.globs ? { globs: [...item.cursor.globs] } : {})
                  }
                }
              : {})
          }))
        }
      : {}),
    ...(config.commands
      ? {
          commands: config.commands.map((item) => ({
            ...item,
            ...(item.targets ? { targets: [...item.targets] } : {})
          }))
        }
      : {}),
    ...(config.skills
      ? {
          skills: config.skills.map((item) => ({
            ...item,
            ...(item.targets ? { targets: [...item.targets] } : {})
          }))
        }
      : {}),
    ...(config.mcpServers
      ? {
          mcpServers: config.mcpServers.map((item) => ({
            ...item,
            ...(item.targets ? { targets: [...item.targets] } : {}),
            ...(item.args ? { args: [...item.args] } : {}),
            ...(item.env ? { env: { ...item.env } } : {}),
            ...(item.headers ? { headers: { ...item.headers } } : {})
          }))
        }
      : {}),
    ...(config.profiles ? { profiles: config.profiles.map(cloneProfile) } : {})
  };
}

function uniqueTargets(targets: Target[]): Target[] {
  const seen = new Set<Target>();
  const resolved: Target[] = [];

  for (const target of targets) {
    if (!seen.has(target)) {
      resolved.push(target);
      seen.add(target);
    }
  }

  return resolved;
}

function getSelectedProfile(config: AgentportConfig, profileName: string): ProfileConfig {
  const profile = (config.profiles ?? []).find((item) => item.name === profileName);

  if (!profile) {
    const availableProfiles = (config.profiles ?? []).map((item) => item.name).join(", ");
    throw new Error(
      availableProfiles
        ? `Unknown profile "${profileName}". Available profiles: ${availableProfiles}`
        : `Unknown profile "${profileName}". Config declares no profiles.`
    );
  }

  return profile;
}

function resolveTargets(profile: ProfileConfig | undefined, options: ResolveConfigOptions): Target[] {
  if (options.allTargets) {
    return [...TARGETS];
  }

  if (options.targets !== undefined) {
    return uniqueTargets(options.targets);
  }

  if (profile?.targets !== undefined) {
    return uniqueTargets(profile.targets);
  }

  return [...TARGETS];
}

export function resolveConfig(
  config: AgentportConfig,
  options: ResolveConfigOptions = {}
): ResolvedConfig {
  validateProfileReferences(config);

  const profile = options.profile ? getSelectedProfile(config, options.profile) : undefined;
  const resolvedConfig = cloneConfig(config);

  if (profile?.rules !== undefined) {
    const selectedNames = new Set(profile.rules);
    resolvedConfig.rules = (resolvedConfig.rules ?? []).filter((item) =>
      selectedNames.has(item.name)
    );
  }

  if (profile?.commands !== undefined) {
    const selectedNames = new Set(profile.commands);
    resolvedConfig.commands = (resolvedConfig.commands ?? []).filter((item) =>
      selectedNames.has(item.name)
    );
  }

  if (profile?.skills !== undefined) {
    const selectedNames = new Set(profile.skills);
    resolvedConfig.skills = (resolvedConfig.skills ?? []).filter((item) =>
      selectedNames.has(item.name)
    );
  }

  if (profile?.mcpServers !== undefined) {
    const selectedNames = new Set(profile.mcpServers);
    resolvedConfig.mcpServers = (resolvedConfig.mcpServers ?? []).filter((item) =>
      selectedNames.has(item.name)
    );
  }

  return {
    config: resolvedConfig,
    targets: resolveTargets(profile, options),
    ...(profile ? { profile: cloneProfile(profile) } : {})
  };
}

export async function loadConfig(configPath: string): Promise<AgentportConfig> {
  const raw = await readFile(configPath, "utf8");
  const parsed = YAML.parse(raw) as unknown;

  if (!isRecord(parsed)) {
    throw new Error("Config root must be a mapping");
  }

  if (parsed.version !== 1) {
    throw new Error('Config must declare `version: 1`');
  }

  if ("instructions" in parsed && parsed.instructions !== undefined) {
    if (!isRecord(parsed.instructions)) {
      throw new Error("instructions must be a mapping");
    }

    if (
      "shared" in parsed.instructions &&
      parsed.instructions.shared !== undefined
    ) {
      ensureStringArray(parsed.instructions.shared, "instructions.shared");
    }

    if (
      "byTarget" in parsed.instructions &&
      parsed.instructions.byTarget !== undefined
    ) {
      if (!isRecord(parsed.instructions.byTarget)) {
        throw new Error("instructions.byTarget must be a mapping");
      }

      for (const [key, value] of Object.entries(parsed.instructions.byTarget)) {
        if (!TARGETS.includes(key as Target)) {
          throw new Error(`instructions.byTarget has unsupported target "${key}"`);
        }
        ensureStringArray(value, `instructions.byTarget.${key}`);
      }
    }
  }

  for (const [key, value] of [
    ["rules", parsed.rules],
    ["commands", parsed.commands],
    ["skills", parsed.skills],
    ["mcpServers", parsed.mcpServers],
    ["profiles", parsed.profiles]
  ] as const) {
    if (value !== undefined && !Array.isArray(value)) {
      throw new Error(`${key} must be an array`);
    }
  }

  const rules = (parsed.rules ?? []) as unknown[];
  const commands = (parsed.commands ?? []) as unknown[];
  const skills = (parsed.skills ?? []) as unknown[];
  const mcpServers = (parsed.mcpServers ?? []) as unknown[];
  const profiles = (parsed.profiles ?? []) as unknown[];

  for (const rule of rules) {
    if (!isRecord(rule) || typeof rule.name !== "string" || typeof rule.content !== "string") {
      throw new Error("Each rule must include string `name` and `content`");
    }

    if (rule.targets !== undefined) {
      ensureTargets(rule.targets, `rules.${rule.name}.targets`);
    }
  }

  for (const command of commands) {
    if (
      !isRecord(command) ||
      typeof command.name !== "string" ||
      typeof command.prompt !== "string"
    ) {
      throw new Error("Each command must include string `name` and `prompt`");
    }

    if (command.targets !== undefined) {
      ensureTargets(command.targets, `commands.${command.name}.targets`);
    }
  }

  for (const skill of skills) {
    if (
      !isRecord(skill) ||
      typeof skill.name !== "string" ||
      typeof skill.description !== "string" ||
      typeof skill.content !== "string"
    ) {
      throw new Error(
        "Each skill must include string `name`, `description`, and `content`"
      );
    }

    if (skill.targets !== undefined) {
      ensureTargets(skill.targets, `skills.${skill.name}.targets`);
    }
  }

  for (const server of mcpServers) {
    if (
      !isRecord(server) ||
      typeof server.name !== "string" ||
      typeof server.transport !== "string"
    ) {
      throw new Error("Each MCP server must include string `name` and `transport`");
    }

    if (!["stdio", "http", "sse"].includes(server.transport)) {
      throw new Error(
        `MCP server "${server.name}" has unsupported transport "${String(server.transport)}"`
      );
    }

    if (server.targets !== undefined) {
      ensureTargets(server.targets, `mcpServers.${server.name}.targets`);
    }
  }

  for (const profile of profiles) {
    if (!isRecord(profile) || typeof profile.name !== "string") {
      throw new Error("Each profile must include string `name`");
    }

    if (profile.description !== undefined && typeof profile.description !== "string") {
      throw new Error(`Profile "${profile.name}" description must be a string`);
    }

    if (profile.targets !== undefined) {
      ensureTargets(profile.targets, `profiles.${profile.name}.targets`);
    }

    for (const category of PROFILE_SELECTION_KEYS) {
      if (profile[category] !== undefined) {
        ensureStringArray(profile[category], `profiles.${profile.name}.${category}`);
      }
    }
  }

  validateProfileReferences(parsed as unknown as AgentportConfig);

  return parsed as unknown as AgentportConfig;
}
