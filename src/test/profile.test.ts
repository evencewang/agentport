import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildProject, formatStdoutOutputs } from "../build.js";
import { loadConfig, resolveConfig } from "../config.js";
import { renderTarget } from "../render.js";
import { TARGETS, type AgentportConfig } from "../types.js";

const profileConfig: AgentportConfig = {
  version: 1,
  project: {
    name: "Profiled Setup"
  },
  instructions: {
    shared: ["Keep work portable."]
  },
  rules: [
    {
      name: "frontend",
      targets: ["cursor"],
      content: "Use React function components."
    },
    {
      name: "backend",
      targets: ["cursor"],
      content: "Keep handlers thin."
    }
  ],
  commands: [
    {
      name: "review",
      targets: ["claude", "cursor", "opencode"],
      prompt: "Review the diff."
    },
    {
      name: "lint",
      prompt: "Run lint checks."
    }
  ],
  skills: [
    {
      name: "release",
      description: "Draft release notes",
      targets: ["claude", "codex", "opencode"],
      content: "Draft concise release notes."
    },
    {
      name: "debug",
      description: "Debug failures",
      content: "Debug a failing test."
    }
  ],
  mcpServers: [
    {
      name: "context7",
      targets: ["claude", "cursor", "opencode"],
      transport: "http",
      url: "https://mcp.context7.com/mcp"
    },
    {
      name: "playwright",
      transport: "stdio",
      command: "npx",
      args: ["@playwright/mcp"]
    }
  ],
  profiles: [
    {
      name: "portable",
      targets: ["claude", "cursor"],
      rules: ["frontend"],
      commands: ["review"],
      skills: ["release"],
      mcpServers: ["context7"]
    },
    {
      name: "empty-tools",
      commands: [],
      mcpServers: []
    }
  ]
};

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeTempConfig(contents: string): Promise<{ configPath: string; dir: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agentport-"));
  const configPath = path.join(dir, "agentkit.yml");
  await writeFile(configPath, contents, "utf8");
  return { configPath, dir };
}

test("selected profile filters items and preserves target filters across renderers", () => {
  const resolved = resolveConfig(profileConfig, { profile: "portable" });

  assert.notEqual(resolved.config, profileConfig);
  assert.deepEqual(resolved.targets, ["claude", "cursor"]);
  assert.deepEqual(
    profileConfig.commands?.map((item) => item.name),
    ["review", "lint"]
  );
  assert.deepEqual(
    resolved.config.commands?.map((item) => item.name),
    ["review"]
  );
  assert.deepEqual(
    resolved.config.skills?.map((item) => item.name),
    ["release"]
  );
  assert.deepEqual(
    resolved.config.mcpServers?.map((item) => item.name),
    ["context7"]
  );

  const claude = renderTarget("claude", resolved.config);
  assert.ok(claude.files[".claude/commands/review.md"]?.includes("Review the diff."));
  assert.ok(
    claude.files[".claude/skills/release/SKILL.md"]?.includes("Draft concise release notes.")
  );
  assert.ok(claude.files[".mcp.json"]?.includes("context7"));
  assert.equal(claude.files[".claude/commands/lint.md"], undefined);
  assert.equal(claude.files[".claude/skills/debug/SKILL.md"], undefined);
  assert.ok(!claude.files[".mcp.json"]?.includes("playwright"));

  const cursor = renderTarget("cursor", resolved.config);
  assert.ok(cursor.files[".cursor/rules/frontend.mdc"]?.includes("React"));
  assert.equal(cursor.files[".cursor/rules/backend.mdc"], undefined);
  assert.ok(cursor.files[".cursor/commands/review.md"]?.includes("Review the diff."));
  assert.ok(cursor.files[".cursor/mcp.json"]?.includes("context7"));
  assert.equal(cursor.warnings.length, 0);
});

test("explicit empty profile categories select none while omitted categories preserve base behavior", () => {
  const resolved = resolveConfig(profileConfig, { profile: "empty-tools" });

  assert.deepEqual(resolved.config.commands, []);
  assert.deepEqual(resolved.config.mcpServers, []);
  assert.deepEqual(
    resolved.config.skills?.map((item) => item.name),
    ["release", "debug"]
  );
  assert.deepEqual(
    resolved.config.rules?.map((item) => item.name),
    ["frontend", "backend"]
  );
});

test("profile resolution deep-clones nested mutable config fields", () => {
  const config: AgentportConfig = {
    version: 1,
    rules: [
      {
        name: "nested-rule",
        targets: ["cursor"],
        cursor: {
          mode: "auto",
          globs: ["src/**/*.ts"]
        },
        content: "Keep UI accessible."
      },
      {
        name: "unselected-rule",
        targets: ["cursor"],
        cursor: {
          mode: "auto",
          globs: ["legacy/**/*.ts"]
        },
        content: "Legacy rule."
      }
    ],
    commands: [
      {
        name: "nested-command",
        targets: ["claude"],
        prompt: "Review nested state."
      },
      {
        name: "unselected-command",
        targets: ["claude"],
        prompt: "Do not select."
      }
    ],
    skills: [
      {
        name: "nested-skill",
        description: "Nested skill",
        targets: ["opencode"],
        content: "Handle nested state."
      },
      {
        name: "unselected-skill",
        description: "Unselected skill",
        targets: ["opencode"],
        content: "Do not select."
      }
    ],
    mcpServers: [
      {
        name: "nested-server",
        targets: ["claude"],
        transport: "stdio",
        command: "node",
        args: ["server.js"],
        env: { TOKEN: "original" },
        headers: { Authorization: "Bearer original" }
      },
      {
        name: "unselected-server",
        targets: ["claude"],
        transport: "stdio",
        command: "node",
        args: ["other.js"],
        env: { TOKEN: "other" },
        headers: { Authorization: "Bearer other" }
      }
    ],
    profiles: [
      {
        name: "selected",
        rules: ["nested-rule"],
        commands: ["nested-command"],
        skills: ["nested-skill"],
        mcpServers: ["nested-server"]
      }
    ]
  };

  const resolved = resolveConfig(config, { profile: "selected" });
  assert.deepEqual(
    resolved.config.rules?.map((item) => item.name),
    ["nested-rule"]
  );
  assert.deepEqual(
    resolved.config.commands?.map((item) => item.name),
    ["nested-command"]
  );
  assert.deepEqual(
    resolved.config.skills?.map((item) => item.name),
    ["nested-skill"]
  );
  assert.deepEqual(
    resolved.config.mcpServers?.map((item) => item.name),
    ["nested-server"]
  );

  resolved.config.rules?.[0]?.targets?.push("claude");
  resolved.config.rules?.[0]?.cursor?.globs?.push("app/**/*.ts");
  resolved.config.commands?.[0]?.targets?.push("cursor");
  resolved.config.skills?.[0]?.targets?.push("claude");
  resolved.config.mcpServers?.[0]?.targets?.push("cursor");
  resolved.config.mcpServers?.[0]?.args?.push("--mutated");
  resolved.config.mcpServers![0]!.env!.TOKEN = "mutated";
  resolved.config.mcpServers![0]!.headers!.Authorization = "Bearer mutated";

  assert.deepEqual(config.rules?.[0]?.targets, ["cursor"]);
  assert.deepEqual(config.rules?.[0]?.cursor?.globs, ["src/**/*.ts"]);
  assert.deepEqual(config.commands?.[0]?.targets, ["claude"]);
  assert.deepEqual(config.skills?.[0]?.targets, ["opencode"]);
  assert.deepEqual(config.mcpServers?.[0]?.targets, ["claude"]);
  assert.deepEqual(config.mcpServers?.[0]?.args, ["server.js"]);
  assert.equal(config.mcpServers?.[0]?.env?.TOKEN, "original");
  assert.equal(config.mcpServers?.[0]?.headers?.Authorization, "Bearer original");
});

test("profile validation rejects unknown profiles, unknown item references, and duplicate selectable names", () => {
  assert.throws(
    () => resolveConfig(profileConfig, { profile: "missing" }),
    /Unknown profile "missing"/
  );

  assert.throws(
    () =>
      resolveConfig(
        {
          ...profileConfig,
          profiles: [{ name: "bad", commands: ["missing-command"] }]
        },
        { profile: "bad" }
      ),
    /Profile "bad" references unknown commands item "missing-command"/
  );

  assert.throws(
    () =>
      resolveConfig(
        {
          ...profileConfig,
          commands: [
            { name: "review", prompt: "A" },
            { name: "review", prompt: "B" }
          ],
          profiles: [{ name: "bad", commands: ["review"] }]
        },
        { profile: "bad" }
      ),
    /item name "review" is duplicated/
  );
});

test("target resolution uses CLI targets, all-targets, profile targets, then defaults", () => {
  assert.deepEqual(resolveConfig(profileConfig, { profile: "portable" }).targets, [
    "claude",
    "cursor"
  ]);
  assert.deepEqual(
    resolveConfig(profileConfig, { profile: "portable", targets: ["opencode", "claude"] })
      .targets,
    ["opencode", "claude"]
  );
  assert.deepEqual(resolveConfig(profileConfig, { profile: "portable", allTargets: true }).targets, [
    ...TARGETS
  ]);
  assert.deepEqual(resolveConfig(profileConfig).targets, [...TARGETS]);
});

test("loadConfig validates profile references from YAML", async () => {
  const { configPath } = await writeTempConfig(`version: 1
commands:
  - name: review
    prompt: Review.
profiles:
  - name: bad
    commands: [missing]
`);

  await assert.rejects(
    () => loadConfig(configPath),
    /Profile "bad" references unknown commands item "missing"/
  );
});

test("dry-run and stdout modes plan outputs without writing files", async () => {
  const { configPath, dir } = await writeTempConfig(`version: 1
project:
  name: Preview Setup
instructions:
  shared:
    - Review generated output first.
commands:
  - name: review
    targets: [claude]
    prompt: Review the diff.
profiles:
  - name: preview
    targets: [claude]
    commands: [review]
`);
  const dryRunOut = path.join(dir, "dry-run-output");
  const stdoutOut = path.join(dir, "stdout-output");

  const dryRun = await buildProject({
    configPath,
    outDir: dryRunOut,
    profile: "preview",
    dryRun: true
  });
  assert.deepEqual(dryRun.writtenFiles, []);
  assert.ok(dryRun.plannedFiles.some((filePath) => filePath.endsWith("claude/CLAUDE.md")));
  assert.equal(await pathExists(path.join(dryRunOut, "claude", "CLAUDE.md")), false);

  const stdout = await buildProject({
    configPath,
    outDir: stdoutOut,
    profile: "preview",
    targets: ["cursor"],
    stdout: true
  });
  assert.deepEqual(stdout.writtenFiles, []);
  assert.deepEqual(stdout.targets, ["cursor"]);
  assert.equal(await pathExists(path.join(stdoutOut, "claude", "CLAUDE.md")), false);
  assert.equal(await pathExists(path.join(stdoutOut, "cursor", "AGENTS.md")), false);
  const stdoutText = formatStdoutOutputs(stdout.outputs);
  assert.ok(stdoutText.includes("=== cursor/AGENTS.md ==="));
  assert.ok(!stdoutText.includes("=== claude/"));
  assert.ok(stdoutText.includes("Review generated output first."));

  const normalOut = path.join(dir, "normal-output");
  const normal = await buildProject({
    configPath,
    outDir: normalOut,
    profile: "preview"
  });
  assert.ok(normal.writtenFiles.some((filePath) => filePath.endsWith("claude/CLAUDE.md")));
  assert.equal(await pathExists(path.join(normalOut, "claude", "CLAUDE.md")), true);
});
