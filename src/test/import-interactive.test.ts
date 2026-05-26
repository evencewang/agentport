import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runInteractiveImport } from "../import-interactive.js";
import { MockPromptAdapter, PROMPT_CANCEL } from "../import-prompts.js";

async function writeText(filePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
}

async function writeMcpFixture(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agentport-interactive-"));
  await writeText(
    path.join(dir, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        first: { command: "node", args: ["a.js"], env: { TOKEN_A: "shhh-secret-a" } },
        second: { command: "node", args: ["b.js"], env: { TOKEN_B: "shhh-secret-b" } }
      }
    })
  );
  await writeText(path.join(dir, ".claude", "commands", "review.md"), "Review prompt\n");
  return dir;
}

async function freshConfigPath(): Promise<string> {
  const configDir = await mkdtemp(path.join(os.tmpdir(), "agentport-interactive-cfg-"));
  return path.join(configDir, "agentkit.yml");
}

test("interactive import prompts for sources when --from omitted", async () => {
  const sourceDir = await writeMcpFixture();
  const configPath = await freshConfigPath();

  const adapter = new MockPromptAdapter();
  adapter.enqueueMultiSelect(["claude"], (msg) => /Select source tools/.test(msg));
  adapter.enqueueMultiSelect(["mcp"], (msg) => /Select item categories/.test(msg));
  adapter.enqueueMultiSelect(["mcp:claude:first"], (msg) => /Select MCP servers/.test(msg));
  adapter.enqueueSelect("keep", (msg) => /Review .* proposed env var/.test(msg));
  adapter.enqueueSelect("confirm", (msg) => /Ready to write\?/.test(msg));

  const outcome = await runInteractiveImport({
    configPath,
    sourceDir,
    adapter
  });

  assert.equal(outcome.cancelled, false);
  assert.equal(outcome.result?.imported.length, 1);
  assert.equal(outcome.result?.imported[0]?.item.name, "first");
  assert.equal(outcome.result?.configWritten, true);
  const written = await readFile(configPath, "utf8");
  assert.doesNotMatch(written, /shhh-secret-a/);
});

test("interactive import preserves independent MCP/skill/command selections", async () => {
  const sourceDir = await writeMcpFixture();
  const configPath = await freshConfigPath();

  const adapter = new MockPromptAdapter();
  adapter.enqueueMultiSelect(["mcp:claude:second"], (msg) => /Select MCP servers/.test(msg));
  adapter.enqueueMultiSelect([], (msg) => /Select Commands/.test(msg));
  adapter.enqueueSelect("keep", (msg) => /Review .* proposed env var/.test(msg));
  adapter.enqueueSelect("confirm", (msg) => /Ready to write\?/.test(msg));

  const outcome = await runInteractiveImport({
    configPath,
    sourceDir,
    sources: ["claude"],
    categories: ["mcp", "commands"],
    adapter
  });

  assert.equal(outcome.cancelled, false);
  assert.equal(outcome.result?.imported.length, 1);
  assert.equal(outcome.result?.imported[0]?.item.name, "second");
  assert.equal(outcome.result?.imported[0]?.category, "mcp");
});

test("interactive import cancels via CANCEL during selection without writing", async () => {
  const sourceDir = await writeMcpFixture();
  const configPath = await freshConfigPath();

  const adapter = new MockPromptAdapter();
  adapter.enqueueMultiSelect(PROMPT_CANCEL, (msg) => /Select MCP servers/.test(msg));

  const outcome = await runInteractiveImport({
    configPath,
    sourceDir,
    sources: ["claude"],
    categories: ["mcp"],
    adapter
  });

  assert.equal(outcome.cancelled, true);
  assert.equal(adapter.cancelled, true);
  assert.equal(outcome.result, undefined);
});

test("interactive import cancels at preview confirmation without writing", async () => {
  const sourceDir = await writeMcpFixture();
  const configPath = await freshConfigPath();

  const adapter = new MockPromptAdapter();
  adapter.enqueueMultiSelect(["mcp:claude:first"], (msg) => /Select MCP servers/.test(msg));
  adapter.enqueueSelect("keep", (msg) => /Review .* proposed env var/.test(msg));
  adapter.enqueueSelect("cancel", (msg) => /Ready to write\?/.test(msg));

  const outcome = await runInteractiveImport({
    configPath,
    sourceDir,
    sources: ["claude"],
    categories: ["mcp"],
    adapter
  });

  assert.equal(outcome.cancelled, true);
  assert.equal(adapter.cancelled, true);
});

test("interactive import resolves rename conflict with validated unique name", async () => {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), "agentport-interactive-rename-"));
  await writeText(path.join(sourceDir, ".claude", "commands", "review.md"), "Imported review\n");

  const configPath = await freshConfigPath();
  await writeText(
    configPath,
    `version: 1\ncommands:\n  - name: review\n    prompt: Existing prompt\n`
  );

  const adapter = new MockPromptAdapter();
  adapter.enqueueMultiSelect(
    ["commands:claude:review"],
    (msg) => /Select Commands/.test(msg)
  );
  adapter.enqueueSelect("rename", (msg) => /Resolve conflict/.test(msg));
  adapter.enqueueText("review-from-claude", (msg) => /New name for review/.test(msg));
  adapter.enqueueSelect("confirm", (msg) => /Ready to write\?/.test(msg));

  const outcome = await runInteractiveImport({
    configPath,
    sourceDir,
    sources: ["claude"],
    categories: ["commands"],
    adapter
  });

  assert.equal(outcome.cancelled, false);
  assert.equal(outcome.result?.configWritten, true);
  const written = await readFile(configPath, "utf8");
  assert.match(written, /review-from-claude/);
  assert.match(written, /Existing prompt/);
  assert.match(written, /Imported review/);
});

test("interactive import never prints or writes literal MCP secrets in default policy", async () => {
  const sourceDir = await writeMcpFixture();
  const configPath = await freshConfigPath();

  const adapter = new MockPromptAdapter();
  adapter.enqueueMultiSelect(
    ["mcp:claude:first", "mcp:claude:second"],
    (msg) => /Select MCP servers/.test(msg)
  );
  adapter.enqueueSelect("keep", (msg) => /Review .* proposed env var/.test(msg));
  adapter.enqueueSelect("confirm", (msg) => /Ready to write\?/.test(msg));

  const outcome = await runInteractiveImport({
    configPath,
    sourceDir,
    sources: ["claude"],
    categories: ["mcp"],
    adapter
  });

  assert.equal(outcome.cancelled, false);
  const written = await readFile(configPath, "utf8");
  assert.doesNotMatch(written, /shhh-secret-a|shhh-secret-b/);
  assert.match(written, /\{env:FIRST_TOKEN_A\}/);
  assert.match(written, /\{env:SECOND_TOKEN_B\}/);

  for (const note of adapter.notes) {
    assert.doesNotMatch(note, /shhh-secret-a|shhh-secret-b/);
  }
  for (const message of adapter.messages) {
    assert.doesNotMatch(message, /shhh-secret-a|shhh-secret-b/);
  }
});

test("interactive revisit preserves prior checklist selections", async () => {
  const sourceDir = await writeMcpFixture();
  const configPath = await freshConfigPath();

  const recordedSelections: string[][] = [];
  const adapter = new MockPromptAdapter();
  adapter.enqueueMultiSelect(
    (() => {
      const captured = ["mcp:claude:first"];
      recordedSelections.push(captured);
      return captured;
    })(),
    (msg) => /Select MCP servers/.test(msg)
  );
  adapter.enqueueSelect("keep", (msg) => /Review .* proposed env var/.test(msg));
  adapter.enqueueSelect("revisit", (msg) => /Ready to write\?/.test(msg));
  // On revisit, the multiselect must reflect the previous selection.
  adapter.enqueueMultiSelect(["mcp:claude:first", "mcp:claude:second"], (msg) =>
    /Select MCP servers/.test(msg)
  );
  adapter.enqueueSelect("keep", (msg) => /Review .* proposed env var/.test(msg));
  adapter.enqueueSelect("confirm", (msg) => /Ready to write\?/.test(msg));

  const outcome = await runInteractiveImport({
    configPath,
    sourceDir,
    sources: ["claude"],
    categories: ["mcp"],
    adapter
  });

  assert.equal(outcome.cancelled, false);
  assert.equal(outcome.result?.imported.length, 2);
  const written = await readFile(configPath, "utf8");
  assert.match(written, /name: first/);
  assert.match(written, /name: second/);
});

test("interactive revisit allows changing a previously chosen conflict action", async () => {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), "agentport-revisit-conflict-"));
  await writeText(path.join(sourceDir, ".claude", "commands", "review.md"), "Imported\n");

  const configPath = await freshConfigPath();
  await writeText(
    configPath,
    `version: 1\ncommands:\n  - name: review\n    prompt: Existing\n`
  );

  const adapter = new MockPromptAdapter();
  adapter.enqueueMultiSelect(["commands:claude:review"], (msg) => /Select Commands/.test(msg));
  adapter.enqueueSelect("keep", (msg) => /Resolve conflict/.test(msg));
  adapter.enqueueSelect("revisit", (msg) => /Ready to write\?/.test(msg));

  adapter.enqueueMultiSelect(["commands:claude:review"], (msg) => /Select Commands/.test(msg));
  adapter.enqueueSelect("replace", (msg) => /Resolve conflict/.test(msg));
  adapter.enqueueSelect("confirm", (msg) => /Ready to write\?/.test(msg));

  const outcome = await runInteractiveImport({
    configPath,
    sourceDir,
    sources: ["claude"],
    categories: ["commands"],
    adapter
  });

  assert.equal(outcome.cancelled, false);
  assert.equal(outcome.result?.imported.length, 1);
  assert.equal(outcome.result?.configWritten, true);
  const yaml = await readFile(configPath, "utf8");
  assert.match(yaml, /Imported/);
  assert.doesNotMatch(yaml, /Existing/);
});

test("interactive env override flow accepts proposed names by default", async () => {
  const sourceDir = await writeMcpFixture();
  const configPath = await freshConfigPath();

  const adapter = new MockPromptAdapter();
  adapter.enqueueMultiSelect(["mcp:claude:first"], (msg) => /Select MCP servers/.test(msg));
  adapter.enqueueSelect("keep", (msg) => /Review .* proposed env var/.test(msg));
  adapter.enqueueSelect("confirm", (msg) => /Ready to write\?/.test(msg));

  const outcome = await runInteractiveImport({
    configPath,
    sourceDir,
    sources: ["claude"],
    categories: ["mcp"],
    adapter
  });

  assert.equal(outcome.cancelled, false);
  const yaml = await readFile(configPath, "utf8");
  assert.match(yaml, /\{env:FIRST_TOKEN_A\}/);
});

test("interactive env override flow edits a proposed env var name", async () => {
  const sourceDir = await writeMcpFixture();
  const configPath = await freshConfigPath();

  const adapter = new MockPromptAdapter();
  adapter.enqueueMultiSelect(["mcp:claude:first"], (msg) => /Select MCP servers/.test(msg));
  adapter.enqueueSelect("edit", (msg) => /Review .* proposed env var/.test(msg));
  adapter.enqueueText("MY_FIRST_TOKEN", (msg) => /Env var for first/.test(msg));
  adapter.enqueueSelect("confirm", (msg) => /Ready to write\?/.test(msg));

  const outcome = await runInteractiveImport({
    configPath,
    sourceDir,
    sources: ["claude"],
    categories: ["mcp"],
    adapter
  });

  assert.equal(outcome.cancelled, false);
  const yaml = await readFile(configPath, "utf8");
  assert.match(yaml, /\{env:MY_FIRST_TOKEN\}/);
  assert.doesNotMatch(yaml, /\{env:FIRST_TOKEN_A\}/);
  assert.ok(outcome.result?.envActionItems.some((item) => item.envVar === "MY_FIRST_TOKEN"));
});

test("interactive import abort during conflict resolution does not write", async () => {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), "agentport-interactive-abort-"));
  await writeText(path.join(sourceDir, ".claude", "commands", "review.md"), "Imported\n");

  const configPath = await freshConfigPath();
  await writeText(
    configPath,
    `version: 1\ncommands:\n  - name: review\n    prompt: Existing\n`
  );
  const before = await readFile(configPath, "utf8");

  const adapter = new MockPromptAdapter();
  adapter.enqueueMultiSelect(
    ["commands:claude:review"],
    (msg) => /Select Commands/.test(msg)
  );
  adapter.enqueueSelect("abort", (msg) => /Resolve conflict/.test(msg));

  const outcome = await runInteractiveImport({
    configPath,
    sourceDir,
    sources: ["claude"],
    categories: ["commands"],
    adapter
  });

  assert.equal(outcome.cancelled, true);
  assert.equal(adapter.cancelled, true);
  assert.equal(await readFile(configPath, "utf8"), before);
});
