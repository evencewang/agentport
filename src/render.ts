import YAML from "yaml";

import {
  type AgentportConfig,
  type BuildWarning,
  type CommandConfig,
  type McpServerConfig,
  type RuleConfig,
  type SkillConfig,
  type Target
} from "./types.js";

export interface RenderResult {
  files: Record<string, string>;
  warnings: BuildWarning[];
}

function matchesTarget(targets: Target[] | undefined, target: Target): boolean {
  return !targets || targets.includes(target);
}

function sanitizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "-");
}

function joinSections(sections: string[]): string {
  return sections.filter(Boolean).join("\n\n").trimEnd() + "\n";
}

function renderInstructionFile(config: AgentportConfig, target: Target): string | null {
  const projectName = config.project?.name ?? "Agent Instructions";
  const shared = config.instructions?.shared ?? [];
  const targetSpecific = config.instructions?.byTarget?.[target] ?? [];
  const bullets = [...shared, ...targetSpecific];

  if (bullets.length === 0) {
    return null;
  }

  return joinSections([
    `# ${projectName}`,
    ...bullets.map((bullet) => `- ${bullet}`)
  ]);
}

function renderSkill(skill: SkillConfig): string {
  return `---\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.content.trimEnd()}\n`;
}

function renderClaudeCommand(command: CommandConfig): string {
  const frontmatter = command.description
    ? `---\ndescription: ${JSON.stringify(command.description)}\n---\n\n`
    : "";

  return `${frontmatter}${command.prompt.trimEnd()}\n`;
}

function renderOpenCodeCommand(command: CommandConfig): string {
  return renderClaudeCommand(command);
}

function renderCursorCommand(command: CommandConfig): string {
  return `${command.prompt.trimEnd()}\n`;
}

function renderCursorRule(rule: RuleConfig): string {
  const cursor = rule.cursor ?? {};
  const metadata: Record<string, unknown> = {};

  if (rule.description) {
    metadata.description = rule.description;
  }

  if (cursor.mode === "always") {
    metadata.alwaysApply = true;
  }

  if (cursor.mode === "auto" && cursor.globs?.length) {
    metadata.globs = cursor.globs;
  }

  if (cursor.mode === "agent_requested" && !rule.description) {
    metadata.description = rule.name;
  }

  const metadataBlock = Object.keys(metadata).length
    ? `---\n${YAML.stringify(metadata).trimEnd()}\n---\n\n`
    : "";

  return `${metadataBlock}${rule.content.trimEnd()}\n`;
}

function renderClaudeMcp(servers: McpServerConfig[]): string {
  const mcpServers: Record<string, Record<string, unknown>> = {};

  for (const server of servers) {
    if (server.transport === "stdio") {
      mcpServers[server.name] = {
        command: server.command,
        args: server.args ?? [],
        env: server.env ?? {}
      };
      continue;
    }

    mcpServers[server.name] = {
      type: server.transport,
      url: server.url,
      headers: server.headers ?? {}
    };
  }

  return `${JSON.stringify({ mcpServers }, null, 2)}\n`;
}

function renderCursorMcp(servers: McpServerConfig[]): string {
  return renderClaudeMcp(servers);
}

function renderOpenCodeMcp(servers: McpServerConfig[]): string {
  const mcp: Record<string, Record<string, unknown>> = {};

  for (const server of servers) {
    if (server.transport === "stdio") {
      mcp[server.name] = {
        type: "local",
        command: server.command ? [server.command, ...(server.args ?? [])] : [],
        env: server.env ?? {}
      };
      continue;
    }

    mcp[server.name] = {
      type: "remote",
      url: server.url,
      headers: server.headers ?? {}
    };
  }

  return `${JSON.stringify({ $schema: "https://opencode.ai/config.json", mcp }, null, 2)}\n`;
}

function addFile(files: Record<string, string>, filePath: string, content: string | null): void {
  if (content) {
    files[filePath] = content;
  }
}

export function renderTarget(target: Target, config: AgentportConfig): RenderResult {
  const files: Record<string, string> = {};
  const warnings: BuildWarning[] = [];

  const rules = (config.rules ?? []).filter((item) => matchesTarget(item.targets, target));
  const commands = (config.commands ?? []).filter((item) =>
    matchesTarget(item.targets, target)
  );
  const skills = (config.skills ?? []).filter((item) => matchesTarget(item.targets, target));
  const mcpServers = (config.mcpServers ?? []).filter((item) =>
    matchesTarget(item.targets, target)
  );

  if (target === "claude") {
    addFile(files, "CLAUDE.md", renderInstructionFile(config, target));

    for (const command of commands) {
      files[`.claude/commands/${sanitizeName(command.name)}.md`] =
        renderClaudeCommand(command);
    }

    for (const skill of skills) {
      files[`.claude/skills/${sanitizeName(skill.name)}/SKILL.md`] = renderSkill(skill);
    }

    if (mcpServers.length > 0) {
      files[".mcp.json"] = renderClaudeMcp(mcpServers);
    }
  }

  if (target === "cursor") {
    addFile(files, "AGENTS.md", renderInstructionFile(config, target));

    for (const rule of rules) {
      files[`.cursor/rules/${sanitizeName(rule.name)}.mdc`] = renderCursorRule(rule);
    }

    for (const command of commands) {
      files[`.cursor/commands/${sanitizeName(command.name)}.md`] =
        renderCursorCommand(command);
    }

    if (skills.length > 0) {
      warnings.push({
        target,
        message:
          "Skipping skills for Cursor in this MVP because official skill file conventions are not documented clearly enough yet."
      });
    }

    if (mcpServers.length > 0) {
      files[".cursor/mcp.json"] = renderCursorMcp(mcpServers);
    }
  }

  if (target === "opencode") {
    addFile(files, "AGENTS.md", renderInstructionFile(config, target));

    for (const command of commands) {
      files[`.opencode/commands/${sanitizeName(command.name)}.md`] =
        renderOpenCodeCommand(command);
    }

    for (const skill of skills) {
      files[`.opencode/skills/${sanitizeName(skill.name)}/SKILL.md`] = renderSkill(skill);
    }

    if (mcpServers.length > 0) {
      files["opencode.json"] = renderOpenCodeMcp(mcpServers);
    }
  }

  if (target === "codex") {
    addFile(files, "AGENTS.md", renderInstructionFile(config, target));

    for (const skill of skills) {
      files[`.codex/skills/${sanitizeName(skill.name)}/SKILL.md`] = renderSkill(skill);
    }

    if (commands.length > 0) {
      warnings.push({
        target,
        message:
          "Skipping commands for Codex in this MVP because command file conventions vary across Codex hosts."
      });
    }

    if (mcpServers.length > 0) {
      warnings.push({
        target,
        message:
          "Skipping MCP output for Codex in this MVP because stable local config conventions are not documented consistently across hosts."
      });
    }

    if (rules.length > 0) {
      warnings.push({
        target,
        message: "Skipping rules for Codex; shared instructions should live in AGENTS.md."
      });
    }
  }

  return { files, warnings };
}
