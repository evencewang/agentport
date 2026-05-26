import test from "node:test";
import assert from "node:assert/strict";

import { renderTarget } from "../render.js";
import type { AgentportConfig } from "../types.js";

const config: AgentportConfig = {
  version: 1,
  project: {
    name: "Portable Setup"
  },
  instructions: {
    shared: ["Keep patches focused."],
    byTarget: {
      claude: ["Use shared slash commands when relevant."]
    }
  },
  rules: [
    {
      name: "frontend",
      description: "Frontend rules",
      targets: ["cursor"],
      cursor: {
        mode: "auto",
        globs: ["src/**/*.tsx"]
      },
      content: "Use React function components."
    }
  ],
  commands: [
    {
      name: "review",
      description: "Review local changes",
      targets: ["claude", "cursor", "opencode"],
      prompt: "Review the current diff."
    }
  ],
  skills: [
    {
      name: "release-notes",
      description: "Draft release notes",
      targets: ["claude", "codex", "opencode"],
      content: "Write concise release notes."
    }
  ],
  mcpServers: [
    {
      name: "context7",
      targets: ["claude", "cursor", "opencode"],
      transport: "http",
      url: "https://mcp.context7.com/mcp"
    }
  ]
};

test("renders Claude files", () => {
  const result = renderTarget("claude", config);

  assert.equal(result.warnings.length, 0);
  assert.ok(result.files["CLAUDE.md"]?.includes("Keep patches focused."));
  assert.ok(result.files["CLAUDE.md"]?.includes("Use shared slash commands"));
  assert.ok(result.files[".claude/commands/review.md"]?.includes("Review the current diff."));
  assert.ok(
    result.files[".claude/skills/release-notes/SKILL.md"]?.includes(
      "description: \"Draft release notes\""
    )
  );
  assert.ok(result.files[".mcp.json"]?.includes("\"context7\""));
});

test("renders Cursor files and warning behavior", () => {
  const result = renderTarget("cursor", config);

  assert.ok(result.files["AGENTS.md"]?.includes("Keep patches focused."));
  assert.ok(result.files[".cursor/rules/frontend.mdc"]?.includes("src/**/*.tsx"));
  assert.ok(result.files[".cursor/commands/review.md"]?.includes("Review the current diff."));
  assert.ok(result.files[".cursor/mcp.json"]?.includes("\"mcpServers\""));
  assert.equal(result.warnings.length, 0);
});

test("renders OpenCode files", () => {
  const result = renderTarget("opencode", config);

  assert.ok(result.files["AGENTS.md"]?.includes("Keep patches focused."));
  assert.ok(result.files[".opencode/commands/review.md"]?.includes("Review the current diff."));
  assert.ok(
    result.files[".opencode/skills/release-notes/SKILL.md"]?.includes(
      "Write concise release notes."
    )
  );
  assert.ok(result.files["opencode.json"]?.includes("\"$schema\""));
});

test("renders Codex files and warns on unsupported surfaces", () => {
  const result = renderTarget("codex", {
    ...config,
    commands: [
      {
        name: "review",
        description: "Review local changes",
        targets: ["codex"],
        prompt: "Review the current diff."
      }
    ],
    mcpServers: [
      {
        name: "context7",
        targets: ["codex"],
        transport: "http",
        url: "https://mcp.context7.com/mcp"
      }
    ]
  });

  assert.ok(result.files["AGENTS.md"]?.includes("Keep patches focused."));
  assert.ok(
    result.files[".codex/skills/release-notes/SKILL.md"]?.includes(
      "Write concise release notes."
    )
  );
  assert.equal(result.warnings.length, 2);
  assert.ok(result.warnings.some((warning) => warning.message.includes("commands")));
  assert.ok(result.warnings.some((warning) => warning.message.includes("MCP")));
});
