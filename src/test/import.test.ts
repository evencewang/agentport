import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { importProject } from "../import.js";
import type { ImportCategory, ImportSource } from "../types.js";

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeText(filePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
}

async function createSourceFixture(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agentport-import-source-"));

  await writeText(
    path.join(dir, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        claudeFs: {
          command: "node",
          args: ["server.js"],
          env: { CLAUDE_TOKEN: "secret" }
        }
      }
    })
  );
  await writeText(path.join(dir, ".claude", "commands", "review.md"), "Claude review prompt\n");
  await writeText(
    path.join(dir, ".claude", "skills", "release", "SKILL.md"),
    "Claude release skill\n"
  );

  await writeText(
    path.join(dir, ".cursor", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        cursorHttp: {
          type: "http",
          url: "https://cursor.example/mcp",
          headers: { Authorization: "Bearer cursor" }
        }
      }
    })
  );
  await writeText(path.join(dir, ".cursor", "commands", "fix.md"), "Cursor fix prompt\n");

  await writeText(
    path.join(dir, "opencode.json"),
    JSON.stringify({
      mcp: {
        openLocal: {
          type: "local",
          command: ["npx", "opencode-mcp"],
          env: { OPEN_TOKEN: "secret" }
        },
        openRemote: {
          type: "remote",
          url: "https://opencode.example/mcp",
          headers: { "X-Api-Key": "secret" }
        }
      }
    })
  );
  await writeText(path.join(dir, ".opencode", "commands", "ship.md"), "OpenCode ship prompt\n");
  await writeText(
    path.join(dir, ".opencode", "skills", "deploy", "SKILL.md"),
    "OpenCode deploy skill\n"
  );

  await writeText(
    path.join(dir, ".codex", "config.toml"),
    `[mcp_servers.codexLocal]
command = "python"
args = ["server.py"]
env = { CODEX_TOKEN = "secret" }

[mcp_servers.codexHttp]
url = "https://codex.example/mcp"
http_headers = { Authorization = "Bearer codex" }
env_http_headers = { X_API_KEY = "CODEX_API_KEY" }
bearer_token_env_var = "CODEX_BEARER"
`
  );
  await writeText(path.join(dir, ".codex", "skills", "audit", "SKILL.md"), "Codex audit skill\n");

  return dir;
}

async function runImport(
  sourceDir: string,
  categories: ImportCategory[],
  sources: ImportSource[] = ["claude"]
) {
  const configDir = await mkdtemp(path.join(os.tmpdir(), "agentport-import-config-"));
  return importProject({
    configPath: path.join(configDir, "agentkit.yml"),
    sourceDir,
    sources,
    categories,
    dryRun: true
  });
}

test("discovers supported Claude, Cursor, OpenCode, and Codex import paths", async () => {
  const sourceDir = await createSourceFixture();
  const configPath = path.join(await mkdtemp(path.join(os.tmpdir(), "agentport-import-")), "agentkit.yml");

  const result = await importProject({
    configPath,
    sourceDir,
    sources: ["claude", "cursor", "opencode", "codex"],
    categories: ["all"],
    dryRun: true
  });

  assert.equal(await pathExists(configPath), false);
  assert.equal(result.imported.filter((item) => item.category === "mcp").length, 6);
  assert.equal(result.imported.filter((item) => item.category === "commands").length, 3);
  assert.equal(result.imported.filter((item) => item.category === "skills").length, 3);
  assert.equal(result.skipped.length, 2);
  assert.ok(result.skipped.some((item) => item.source === "cursor" && item.category === "skills"));
  assert.ok(result.skipped.some((item) => item.source === "codex" && item.category === "commands"));

  const codexHttp = result.mergedConfig.mcpServers?.find((item) => item.name === "codexHttp");
  assert.equal(codexHttp?.transport, "http");
  assert.equal(codexHttp?.url, "https://codex.example/mcp");
  assert.equal(codexHttp?.headers?.Authorization, "Bearer codex");
  assert.equal(codexHttp?.headers?.X_API_KEY, "{env:CODEX_API_KEY}");
  assert.ok(result.warnings.length >= 4);
  assert.ok(
    result.envActionItems.some(
      (item) => item.itemName === "codexHttp" && item.reason === "env-http-headers"
    )
  );
  assert.ok(
    result.envActionItems.some(
      (item) => item.itemName === "codexHttp" && item.reason === "authorization-conflict"
    )
  );
});

test("discovers OpenCode global command and skill config directories", async () => {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), "agentport-opencode-global-"));
  const configPath = path.join(await mkdtemp(path.join(os.tmpdir(), "agentport-import-")), "agentkit.yml");

  await writeText(path.join(sourceDir, "opencode.json"), JSON.stringify({ mcp: {} }));
  await writeText(path.join(sourceDir, "commands", "review.md"), "Review from global commands\n");
  await writeText(path.join(sourceDir, "command", "legacy.md"), "Review from legacy command dir\n");
  await writeText(
    path.join(sourceDir, "skills", "release", "SKILL.md"),
    "OpenCode global release skill\n"
  );

  const result = await importProject({
    configPath,
    sourceDir,
    sources: ["opencode"],
    categories: ["all"],
    dryRun: true
  });

  assert.deepEqual(result.mergedConfig.commands?.map((item) => item.name), ["review", "legacy"]);
  assert.deepEqual(result.mergedConfig.skills?.map((item) => item.name), ["release"]);
  assert.equal(result.imported.filter((item) => item.category === "commands").length, 2);
  assert.equal(result.imported.filter((item) => item.category === "skills").length, 1);
});

test("category selection imports only requested categories", async () => {
  const sourceDir = await createSourceFixture();

  const mcpOnly = await runImport(sourceDir, ["mcp"]);
  assert.equal(mcpOnly.imported.filter((item) => item.category === "mcp").length, 1);
  assert.equal(mcpOnly.imported.some((item) => item.category === "commands"), false);
  assert.equal(mcpOnly.imported.some((item) => item.category === "skills"), false);

  const commandsOnly = await runImport(sourceDir, ["commands"]);
  assert.deepEqual(commandsOnly.mergedConfig.commands?.map((item) => item.name), ["review"]);
  assert.equal(commandsOnly.mergedConfig.mcpServers, undefined);

  const skillsOnly = await runImport(sourceDir, ["skills"]);
  assert.deepEqual(skillsOnly.mergedConfig.skills?.map((item) => item.name), ["release"]);
  assert.equal(skillsOnly.mergedConfig.commands, undefined);

  const all = await runImport(sourceDir, ["all"]);
  assert.ok(all.mergedConfig.mcpServers?.length);
  assert.ok(all.mergedConfig.commands?.length);
  assert.ok(all.mergedConfig.skills?.length);
});

test("supported source/category combinations with no matches are reported as zero discovered", async () => {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), "agentport-import-empty-source-"));
  const result = await runImport(sourceDir, ["mcp", "commands", "skills"], ["claude"]);

  assert.deepEqual(
    result.discovery.map((item) => ({
      source: item.source,
      category: item.category,
      supported: item.supported,
      discovered: item.discovered
    })),
    [
      { source: "claude", category: "mcp", supported: true, discovered: 0 },
      { source: "claude", category: "skills", supported: true, discovered: 0 },
      { source: "claude", category: "commands", supported: true, discovered: 0 }
    ]
  );
  assert.equal(result.skipped.length, 0);
  assert.equal(result.imported.length, 0);
});

test("unsupported combinations also appear in discovery status", async () => {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), "agentport-import-unsupported-source-"));
  const result = await runImport(sourceDir, ["skills"], ["cursor"]);

  assert.deepEqual(result.discovery, [
    {
      source: "cursor",
      category: "skills",
      supported: false,
      discovered: 0,
      reason: "cursor skills import is not supported"
    }
  ]);
  assert.equal(result.skipped.length, 1);
});

test("import merge creates missing config, appends, skips equivalent duplicates, and aborts conflicts", async () => {
  const sourceDir = await createSourceFixture();
  const createDir = await mkdtemp(path.join(os.tmpdir(), "agentport-import-create-"));
  const createConfig = path.join(createDir, "agentkit.yml");

  const created = await importProject({
    configPath: createConfig,
    sourceDir,
    sources: ["claude"],
    categories: ["commands"]
  });
  assert.equal(created.configWritten, true);
  assert.match(await readFile(createConfig, "utf8"), /review/);

  const appendConfig = path.join(await mkdtemp(path.join(os.tmpdir(), "agentport-import-append-")), "agentkit.yml");
  await writeText(
    appendConfig,
    `version: 1
commands:
  - name: existing
    prompt: Existing prompt
`
  );
  const appended = await importProject({
    configPath: appendConfig,
    sourceDir,
    sources: ["claude"],
    categories: ["commands"]
  });
  assert.equal(appended.configWritten, true);
  assert.deepEqual(appended.mergedConfig.commands?.map((item) => item.name), ["existing", "review"]);

  const duplicateConfig = path.join(
    await mkdtemp(path.join(os.tmpdir(), "agentport-import-dupe-")),
    "agentkit.yml"
  );
  await writeText(
    duplicateConfig,
    `version: 1
commands:
  - name: review
    prompt: |
      Claude review prompt
`
  );
  const duplicate = await importProject({
    configPath: duplicateConfig,
    sourceDir,
    sources: ["claude"],
    categories: ["commands"]
  });
  assert.equal(duplicate.configWritten, false);
  assert.equal(duplicate.unchanged.length, 1);
  assert.equal(duplicate.configChanged, false);

  const conflictConfig = path.join(
    await mkdtemp(path.join(os.tmpdir(), "agentport-import-conflict-")),
    "agentkit.yml"
  );
  await writeText(
    conflictConfig,
    `version: 1
commands:
  - name: review
    prompt: Different prompt
`
  );
  const beforeConflict = await readFile(conflictConfig, "utf8");
  const conflict = await importProject({
    configPath: conflictConfig,
    sourceDir,
    sources: ["claude"],
    categories: ["commands"]
  });
  assert.equal(conflict.conflicts.length, 1);
  assert.equal(conflict.configWritten, false);
  assert.equal(await readFile(conflictConfig, "utf8"), beforeConflict);
});

test("same-name HTTP MCP imports compare runtime identity instead of Agentport metadata", async () => {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), "agentport-import-mcp-same-runtime-"));
  await writeText(
    path.join(sourceDir, "opencode.json"),
    JSON.stringify({
      mcp: {
        context7: {
          type: "remote",
          url: "HTTPS://MCP.CONTEXT7.COM/mcp/",
          headers: { CONTEXT7_API_KEY: "imported-secret" }
        }
      }
    })
  );

  const configPath = path.join(
    await mkdtemp(path.join(os.tmpdir(), "agentport-import-mcp-existing-")),
    "agentkit.yml"
  );
  await writeText(
    configPath,
    `version: 1
mcpServers:
  - name: context7
    targets: [claude, cursor]
    transport: http
    url: https://mcp.context7.com/mcp
    headers:
      CONTEXT7_API_KEY: "{env:CONTEXT7_API_KEY}"
`
  );

  const result = await importProject({
    configPath,
    sourceDir,
    sources: ["opencode"],
    categories: ["mcp"],
    dryRun: true
  });

  assert.equal(result.conflicts.length, 0);
  assert.equal(result.unchanged.length, 1);
  assert.equal(result.merged.length, 0);
  assert.equal(result.configChanged, false);
  assert.deepEqual(result.mergedConfig.mcpServers?.[0], {
    name: "context7",
    targets: ["claude", "cursor"],
    transport: "http",
    url: "https://mcp.context7.com/mcp",
    headers: { CONTEXT7_API_KEY: "{env:CONTEXT7_API_KEY}" }
  });
});

test("same-name MCP imports merge explicit target eligibility without duplicating targets", async () => {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), "agentport-import-mcp-targets-"));
  await writeText(
    path.join(sourceDir, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        context7: {
          type: "http",
          url: "https://mcp.context7.com/mcp",
          targets: ["cursor", "opencode", "opencode"]
        }
      }
    })
  );

  const configPath = path.join(
    await mkdtemp(path.join(os.tmpdir(), "agentport-import-mcp-merge-")),
    "agentkit.yml"
  );
  await writeText(
    configPath,
    `version: 1
mcpServers:
  - name: context7
    targets: [claude, cursor]
    transport: http
    url: https://mcp.context7.com/mcp
`
  );

  const result = await importProject({
    configPath,
    sourceDir,
    sources: ["claude"],
    categories: ["mcp"]
  });

  assert.equal(result.configWritten, true);
  assert.equal(result.imported.length, 0);
  assert.equal(result.unchanged.length, 0);
  assert.equal(result.merged.length, 1);
  assert.deepEqual(result.merged[0]?.mergedTargets, ["opencode"]);
  assert.deepEqual(result.mergedConfig.mcpServers?.[0]?.targets, ["claude", "cursor", "opencode"]);
});

test("same-name MCP runtime and secret-shape differences remain blocking conflicts", async () => {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), "agentport-import-mcp-conflict-source-"));
  await writeText(
    path.join(sourceDir, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        context7: {
          type: "http",
          url: "https://mcp.context7.com/other",
          headers: { "X-Api-Key": "imported-secret" }
        }
      }
    })
  );

  const configPath = path.join(
    await mkdtemp(path.join(os.tmpdir(), "agentport-import-mcp-conflict-config-")),
    "agentkit.yml"
  );
  await writeText(
    configPath,
    `version: 1
mcpServers:
  - name: context7
    transport: http
    url: https://mcp.context7.com/mcp
    headers:
      Authorization: existing-secret
`
  );
  const before = await readFile(configPath, "utf8");

  const result = await importProject({
    configPath,
    sourceDir,
    sources: ["claude"],
    categories: ["mcp"]
  });

  assert.equal(result.conflicts.length, 1);
  assert.match(result.conflicts[0]!.message, /endpoint/);
  assert.match(result.conflicts[0]!.message, /header keys/);
  assert.doesNotMatch(result.conflicts[0]!.message, /imported-secret|existing-secret/);
  assert.equal(result.configWritten, false);
  assert.equal(await readFile(configPath, "utf8"), before);
});

test("different-name same-runtime MCP imports report non-blocking possible duplicates", async () => {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), "agentport-import-mcp-duplicates-source-"));
  await writeText(
    path.join(sourceDir, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        context7Alias: {
          type: "http",
          url: "https://mcp.context7.com/mcp",
          headers: { Authorization: "imported-http-secret" }
        },
        playwrightAlias: {
          command: "npx",
          args: ["@playwright/mcp"],
          env: { PLAYWRIGHT_TOKEN: "imported-stdio-secret" }
        }
      }
    })
  );

  const configPath = path.join(
    await mkdtemp(path.join(os.tmpdir(), "agentport-import-mcp-duplicates-config-")),
    "agentkit.yml"
  );
  await writeText(
    configPath,
    `version: 1
mcpServers:
  - name: context7
    transport: http
    url: https://mcp.context7.com/mcp/
    headers:
      Authorization: existing-http-secret
  - name: playwright
    transport: stdio
    command: npx
    args: ["@playwright/mcp"]
    env:
      PLAYWRIGHT_TOKEN: existing-stdio-secret
`
  );

  const result = await importProject({
    configPath,
    sourceDir,
    sources: ["claude"],
    categories: ["mcp"]
  });

  assert.equal(result.conflicts.length, 0);
  assert.equal(result.configWritten, true);
  assert.equal(result.imported.length, 2);
  assert.equal(result.possibleDuplicates.length, 2);
  assert.deepEqual(
    result.possibleDuplicates.map((item) => [item.importedName, item.existingName]),
    [
      ["context7Alias", "context7"],
      ["playwrightAlias", "playwright"]
    ]
  );
  assert.ok(result.mergedConfig.mcpServers?.some((item) => item.name === "context7Alias"));
  assert.ok(result.mergedConfig.mcpServers?.some((item) => item.name === "playwrightAlias"));
  for (const duplicate of result.possibleDuplicates) {
    assert.doesNotMatch(
      duplicate.message,
      /imported-http-secret|existing-http-secret|imported-stdio-secret|existing-stdio-secret/
    );
  }
});

test("dry-run does not create or modify config files", async () => {
  const sourceDir = await createSourceFixture();
  const missingConfig = path.join(
    await mkdtemp(path.join(os.tmpdir(), "agentport-import-dry-missing-")),
    "agentkit.yml"
  );
  const missing = await importProject({
    configPath: missingConfig,
    sourceDir,
    sources: ["claude"],
    categories: ["commands"],
    dryRun: true
  });
  assert.equal(missing.configWritten, false);
  assert.equal(await pathExists(missingConfig), false);

  const existingConfig = path.join(
    await mkdtemp(path.join(os.tmpdir(), "agentport-import-dry-existing-")),
    "agentkit.yml"
  );
  await writeText(existingConfig, "version: 1\n");
  const before = await readFile(existingConfig, "utf8");
  const existing = await importProject({
    configPath: existingConfig,
    sourceDir,
    sources: ["claude"],
    categories: ["commands"],
    dryRun: true
  });
  assert.equal(existing.configWritten, false);
  assert.equal(await readFile(existingConfig, "utf8"), before);
});

test("invalid MCP files include source paths in actionable errors", async () => {
  const jsonDir = await mkdtemp(path.join(os.tmpdir(), "agentport-import-bad-json-"));
  await writeText(path.join(jsonDir, ".mcp.json"), "{bad json");
  await assert.rejects(
    () => runImport(jsonDir, ["mcp"], ["claude"]),
    /Invalid MCP JSON at .*\.mcp\.json.*exclude mcp/
  );

  const tomlDir = await mkdtemp(path.join(os.tmpdir(), "agentport-import-bad-toml-"));
  await writeText(path.join(tomlDir, ".codex", "config.toml"), "[mcp_servers.bad]\nnot valid\n");
  await assert.rejects(
    () => runImport(tomlDir, ["mcp"], ["codex"]),
    /Invalid MCP TOML at .*\.codex\/config\.toml.*exclude mcp/
  );
});
