import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  applyImportPlan,
  importProject,
  planImport,
  type ConflictAction,
  type ResolvedSelection
} from "../import.js";

async function writeText(filePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
}

async function makeSourceWithMcp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agentport-plan-"));
  await writeText(
    path.join(dir, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        first: { command: "node", args: ["a.js"], env: { TOKEN_A: "literal-a" } },
        second: { command: "node", args: ["b.js"], env: { TOKEN_B: "$EXISTING_B" } }
      }
    })
  );
  return dir;
}

async function makeConfigDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "agentport-plan-config-"));
}

test("planImport returns categorized candidates with stable ids", async () => {
  const sourceDir = await makeSourceWithMcp();
  const configDir = await makeConfigDir();
  const configPath = path.join(configDir, "agentkit.yml");

  const plan = await planImport({
    configPath,
    sourceDir,
    sources: ["claude"],
    categories: ["mcp"]
  });

  assert.equal(plan.candidates.length, 2);
  assert.deepEqual(
    plan.candidates.map((candidate) => candidate.id).sort(),
    ["mcp:claude:first", "mcp:claude:second"]
  );
  for (const candidate of plan.candidates) {
    assert.equal(candidate.classification.kind, "new");
  }
});

test("applyImportPlan with empty selection writes nothing", async () => {
  const sourceDir = await makeSourceWithMcp();
  const configDir = await makeConfigDir();
  const configPath = path.join(configDir, "agentkit.yml");

  const plan = await planImport({
    configPath,
    sourceDir,
    sources: ["claude"],
    categories: ["mcp"]
  });

  const empty: ResolvedSelection = {
    selectedIds: new Set<string>(),
    conflictActions: new Map<string, ConflictAction>()
  };

  const result = await applyImportPlan({ plan, selection: empty });

  assert.equal(result.imported.length, 0);
  assert.equal(result.configWritten, false);
  assert.equal(result.configChanged, false);
});

test("applyImportPlan picks selected candidates by id", async () => {
  const sourceDir = await makeSourceWithMcp();
  const configDir = await makeConfigDir();
  const configPath = path.join(configDir, "agentkit.yml");

  const plan = await planImport({
    configPath,
    sourceDir,
    sources: ["claude"],
    categories: ["mcp"]
  });

  const selection: ResolvedSelection = {
    selectedIds: new Set<string>(["mcp:claude:first"]),
    conflictActions: new Map<string, ConflictAction>()
  };

  const result = await applyImportPlan({ plan, selection });

  assert.equal(result.imported.length, 1);
  assert.equal(result.imported[0]?.item.name, "first");
  assert.equal(result.configWritten, true);
  const written = await readFile(configPath, "utf8");
  assert.match(written, /first/);
  assert.doesNotMatch(written, /second/);
});

test("conflict actions: keep, replace, rename, abort", async () => {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), "agentport-conflict-source-"));
  await writeText(
    path.join(sourceDir, ".claude", "commands", "review.md"),
    "Imported review prompt\n"
  );

  async function makePlan(): Promise<ReturnType<typeof planImport>> {
    const configDir = await makeConfigDir();
    const configPath = path.join(configDir, "agentkit.yml");
    await writeText(
      configPath,
      `version: 1\ncommands:\n  - name: review\n    prompt: Existing prompt\n`
    );
    return planImport({
      configPath,
      sourceDir,
      sources: ["claude"],
      categories: ["commands"]
    });
  }

  // keep
  {
    const plan = await makePlan();
    const candidate = plan.candidates[0]!;
    const result = await applyImportPlan({
      plan,
      selection: {
        selectedIds: new Set([candidate.id]),
        conflictActions: new Map([[candidate.id, { type: "keep" } as ConflictAction]])
      }
    });
    assert.equal(result.imported.length, 0);
    assert.equal(result.conflicts.length, 0);
    assert.equal(result.configWritten, false);
  }

  // replace
  {
    const plan = await makePlan();
    const candidate = plan.candidates[0]!;
    const result = await applyImportPlan({
      plan,
      selection: {
        selectedIds: new Set([candidate.id]),
        conflictActions: new Map([[candidate.id, { type: "replace" } as ConflictAction]])
      }
    });
    assert.equal(result.imported.length, 1);
    assert.equal(result.conflicts.length, 0);
    assert.equal(result.configWritten, true);
    assert.match(await readFile(plan.configPath, "utf8"), /Imported review prompt/);
  }

  // rename
  {
    const plan = await makePlan();
    const candidate = plan.candidates[0]!;
    const result = await applyImportPlan({
      plan,
      selection: {
        selectedIds: new Set([candidate.id]),
        conflictActions: new Map([
          [candidate.id, { type: "rename", newName: "review-imported" } as ConflictAction]
        ])
      }
    });
    assert.equal(result.imported.length, 1);
    assert.equal(result.imported[0]?.item.name, "review-imported");
    assert.equal(result.configWritten, true);
    const written = await readFile(plan.configPath, "utf8");
    assert.match(written, /review-imported/);
    assert.match(written, /Existing prompt/);
  }

  // abort
  {
    const plan = await makePlan();
    const candidate = plan.candidates[0]!;
    const before = await readFile(plan.configPath, "utf8");
    const result = await applyImportPlan({
      plan,
      selection: {
        selectedIds: new Set([candidate.id]),
        conflictActions: new Map([[candidate.id, { type: "abort" } as ConflictAction]])
      }
    });
    assert.equal(result.aborted, true);
    assert.equal(result.configWritten, false);
    assert.equal(await readFile(plan.configPath, "utf8"), before);
  }
});

test("conflict action: rename rejects duplicate names", async () => {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), "agentport-rename-source-"));
  await writeText(path.join(sourceDir, ".claude", "commands", "review.md"), "Imported\n");
  const configDir = await makeConfigDir();
  const configPath = path.join(configDir, "agentkit.yml");
  await writeText(
    configPath,
    `version: 1\ncommands:\n  - name: review\n    prompt: Existing\n  - name: review-imported\n    prompt: Other\n`
  );

  const plan = await planImport({
    configPath,
    sourceDir,
    sources: ["claude"],
    categories: ["commands"]
  });
  const candidate = plan.candidates[0]!;
  await assert.rejects(
    () =>
      applyImportPlan({
        plan,
        selection: {
          selectedIds: new Set([candidate.id]),
          conflictActions: new Map([
            [candidate.id, { type: "rename", newName: "review-imported" } as ConflictAction]
          ])
        }
      }),
    /Renamed commands item "review-imported" conflicts/
  );
});

test("safe MCP target merge is applied automatically when runtime+secret shape match", async () => {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), "agentport-safe-merge-source-"));
  await writeText(
    path.join(sourceDir, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        ctx: {
          type: "http",
          url: "https://example.com/mcp",
          headers: { Authorization: "same-shape" },
          targets: ["claude", "codex"]
        }
      }
    })
  );
  const configDir = await makeConfigDir();
  const configPath = path.join(configDir, "agentkit.yml");
  await writeText(
    configPath,
    `version: 1
mcpServers:
  - name: ctx
    transport: http
    url: https://example.com/mcp
    headers:
      Authorization: "{env:CTX_AUTHORIZATION}"
    targets: [claude]
`
  );

  const plan = await planImport({
    configPath,
    sourceDir,
    sources: ["claude"],
    categories: ["mcp"]
  });
  const candidate = plan.candidates[0]!;
  assert.equal(candidate.classification.kind, "merge");
  if (candidate.classification.kind !== "merge") {
    return;
  }
  assert.deepEqual(candidate.classification.mergedTargets, ["codex"]);

  const result = await applyImportPlan({ plan });
  assert.equal(result.merged.length, 1);
  assert.deepEqual(result.merged[0]?.mergedTargets, ["codex"]);
  assert.equal(result.configWritten, true);
  const written = await readFile(configPath, "utf8");
  assert.match(written, /\{env:CTX_AUTHORIZATION\}/);
  assert.doesNotMatch(written, /same-shape/);
});

test("conflict action: merge errors for unsafe MCP conflicts (no safe merge offered)", async () => {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), "agentport-unsafe-merge-source-"));
  await writeText(
    path.join(sourceDir, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        ctx: {
          type: "http",
          url: "https://example.com/mcp",
          headers: { Authorization: "different-secret" },
          targets: ["claude", "codex"]
        }
      }
    })
  );
  const configDir = await makeConfigDir();
  const configPath = path.join(configDir, "agentkit.yml");
  await writeText(
    configPath,
    `version: 1
mcpServers:
  - name: ctx
    transport: http
    url: https://example.com/other
    headers:
      Authorization: existing-secret
    targets: [claude]
`
  );

  const plan = await planImport({
    configPath,
    sourceDir,
    sources: ["claude"],
    categories: ["mcp"]
  });
  const candidate = plan.candidates[0]!;
  assert.equal(candidate.classification.kind, "conflict");
  if (candidate.classification.kind !== "conflict") {
    return;
  }
  assert.equal(candidate.classification.safeMergeAvailable, false);

  const result = await applyImportPlan({
    plan,
    selection: {
      selectedIds: new Set([candidate.id]),
      conflictActions: new Map([[candidate.id, { type: "merge" } as ConflictAction]])
    }
  });

  assert.equal(result.conflicts.length, 1);
  assert.match(result.conflicts[0]!.message, /No safe merge available/);
  assert.equal(result.configWritten, false);
  assert.doesNotMatch(result.conflicts[0]!.message, /different-secret|existing-secret/);
});

test("cross-source same-name candidates: first wins as new, later marked as conflict (earlier-candidate)", async () => {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), "agentport-cross-source-"));
  await writeText(path.join(sourceDir, ".claude", "commands", "review.md"), "Claude review\n");
  await writeText(path.join(sourceDir, ".cursor", "commands", "review.md"), "Cursor review\n");

  const configDir = await makeConfigDir();
  const configPath = path.join(configDir, "agentkit.yml");

  const plan = await planImport({
    configPath,
    sourceDir,
    sources: ["claude", "cursor"],
    categories: ["commands"]
  });

  assert.equal(plan.candidates.length, 2);
  const claude = plan.candidates.find((c) => c.id === "commands:claude:review");
  const cursor = plan.candidates.find((c) => c.id === "commands:cursor:review");
  assert.equal(claude?.classification.kind, "new");
  assert.equal(cursor?.classification.kind, "conflict");
  if (cursor?.classification.kind === "conflict") {
    assert.equal(cursor.classification.conflictSource, "earlier-candidate");
    assert.doesNotMatch(cursor.classification.existingSummary, /Claude review/);
    assert.doesNotMatch(cursor.classification.incomingSummary, /Cursor review/);
  }

  const defaultResult = await applyImportPlan({ plan });
  assert.equal(defaultResult.imported.length, 1);
  assert.equal(defaultResult.conflicts.length, 1);
  assert.equal(defaultResult.configWritten, false);
});

test("cross-source same-name candidates with identical content classify as unchanged", async () => {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), "agentport-cross-source-eq-"));
  await writeText(path.join(sourceDir, ".claude", "commands", "review.md"), "Shared review\n");
  await writeText(path.join(sourceDir, ".cursor", "commands", "review.md"), "Shared review\n");

  const configDir = await makeConfigDir();
  const configPath = path.join(configDir, "agentkit.yml");

  const plan = await planImport({
    configPath,
    sourceDir,
    sources: ["claude", "cursor"],
    categories: ["commands"]
  });

  assert.equal(plan.candidates[0]?.classification.kind, "new");
  assert.equal(plan.candidates[1]?.classification.kind, "unchanged");

  const result = await applyImportPlan({ plan });
  assert.equal(result.imported.length, 1);
  assert.equal(result.configWritten, true);
  const yaml = await readFile(configPath, "utf8");
  const matches = yaml.match(/name: review/g) ?? [];
  assert.equal(matches.length, 1);
});

test("cross-source conflict: replace removes the earlier-candidate entry", async () => {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), "agentport-cross-replace-"));
  await writeText(path.join(sourceDir, ".claude", "commands", "review.md"), "Claude review\n");
  await writeText(path.join(sourceDir, ".cursor", "commands", "review.md"), "Cursor review\n");

  const configDir = await makeConfigDir();
  const configPath = path.join(configDir, "agentkit.yml");

  const plan = await planImport({
    configPath,
    sourceDir,
    sources: ["claude", "cursor"],
    categories: ["commands"]
  });

  const cursor = plan.candidates.find((c) => c.id === "commands:cursor:review")!;
  const result = await applyImportPlan({
    plan,
    selection: {
      selectedIds: new Set(plan.candidates.map((c) => c.id)),
      conflictActions: new Map([[cursor.id, { type: "replace" } as ConflictAction]])
    }
  });

  assert.equal(result.imported.length, 1);
  assert.equal(result.imported[0]?.source, "cursor");
  assert.equal(result.configWritten, true);
  const yaml = await readFile(configPath, "utf8");
  assert.match(yaml, /Cursor review/);
  assert.doesNotMatch(yaml, /Claude review/);
});

test("deselecting a conflicting candidate does not block write", async () => {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), "agentport-deselect-conflict-"));
  await writeText(path.join(sourceDir, ".claude", "commands", "review.md"), "Imported\n");
  await writeText(path.join(sourceDir, ".claude", "commands", "other.md"), "Imported other\n");

  const configDir = await makeConfigDir();
  const configPath = path.join(configDir, "agentkit.yml");
  await writeText(
    configPath,
    `version: 1\ncommands:\n  - name: review\n    prompt: Existing\n`
  );

  const plan = await planImport({
    configPath,
    sourceDir,
    sources: ["claude"],
    categories: ["commands"]
  });

  const conflict = plan.candidates.find((c) => c.id === "commands:claude:review")!;
  const other = plan.candidates.find((c) => c.id === "commands:claude:other")!;
  assert.equal(conflict.classification.kind, "conflict");

  const result = await applyImportPlan({
    plan,
    selection: {
      selectedIds: new Set([other.id]),
      conflictActions: new Map()
    }
  });

  assert.equal(result.conflicts.length, 0);
  assert.equal(result.imported.length, 1);
  assert.equal(result.imported[0]?.item.name, "other");
  assert.equal(result.configWritten, true);
  const yaml = await readFile(configPath, "utf8");
  assert.match(yaml, /Existing/);
  assert.match(yaml, /Imported other/);
  assert.doesNotMatch(yaml, /Imported\n/);
});

test("envActionItems on result include only selected/written items", async () => {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), "agentport-env-action-selection-"));
  await writeText(
    path.join(sourceDir, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        kept: {
          command: "node",
          args: ["a.js"],
          env: { TOKEN: "literal-secret-a" }
        },
        dropped: {
          command: "node",
          args: ["b.js"],
          env: { TOKEN: "literal-secret-b" }
        }
      }
    })
  );

  const configDir = await makeConfigDir();
  const configPath = path.join(configDir, "agentkit.yml");

  const { INTERACTIVE_ENV_POLICY } = await import("../import-env.js");
  const plan = await planImport({
    configPath,
    sourceDir,
    sources: ["claude"],
    categories: ["mcp"],
    envPolicy: INTERACTIVE_ENV_POLICY
  });

  const kept = plan.candidates.find((c) => c.id === "mcp:claude:kept")!;
  const result = await applyImportPlan({
    plan,
    selection: {
      selectedIds: new Set([kept.id]),
      conflictActions: new Map()
    }
  });

  assert.equal(result.imported.length, 1);
  assert.equal(result.envActionItems.length, 1);
  assert.equal(result.envActionItems[0]?.itemName, "kept");
  assert.ok(result.envActionItems.every((item) => item.itemName === "kept"));
  for (const item of result.envActionItems) {
    assert.doesNotMatch(item.message, /literal-secret-a|literal-secret-b/);
  }
});

test("envOverrides rewrite placeholder values and action item names", async () => {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), "agentport-env-override-"));
  await writeText(
    path.join(sourceDir, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        api: {
          command: "node",
          args: ["server.js"],
          env: { TOKEN: "literal-secret" }
        }
      }
    })
  );

  const configDir = await makeConfigDir();
  const configPath = path.join(configDir, "agentkit.yml");

  const { INTERACTIVE_ENV_POLICY } = await import("../import-env.js");
  const plan = await planImport({
    configPath,
    sourceDir,
    sources: ["claude"],
    categories: ["mcp"],
    envPolicy: INTERACTIVE_ENV_POLICY
  });

  const candidate = plan.candidates[0]!;
  const result = await applyImportPlan({
    plan,
    selection: {
      selectedIds: new Set([candidate.id]),
      conflictActions: new Map(),
      envOverrides: [
        {
          candidateId: candidate.id,
          fieldKind: "env",
          fieldKey: "TOKEN",
          envVar: "MY_CUSTOM_TOKEN"
        }
      ]
    }
  });

  assert.equal(result.configWritten, true);
  const yaml = await readFile(configPath, "utf8");
  assert.match(yaml, /\{env:MY_CUSTOM_TOKEN\}/);
  assert.doesNotMatch(yaml, /API_TOKEN|literal-secret/);
  assert.ok(result.envActionItems.some((item) => item.envVar === "MY_CUSTOM_TOKEN"));
  for (const item of result.envActionItems) {
    assert.doesNotMatch(item.message, /literal-secret/);
  }
});

test("envOverrides rewrite bearer token Authorization header placeholder", async () => {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), "agentport-bearer-override-"));
  await writeText(
    path.join(sourceDir, ".codex", "config.toml"),
    `[mcp_servers.api]
url = "https://api.example.com/mcp"
bearer_token_env_var = "API_TOKEN"
`
  );

  const configDir = await makeConfigDir();
  const configPath = path.join(configDir, "agentkit.yml");

  const plan = await planImport({
    configPath,
    sourceDir,
    sources: ["codex"],
    categories: ["mcp"]
  });

  const candidate = plan.candidates[0]!;
  const result = await applyImportPlan({
    plan,
    selection: {
      selectedIds: new Set([candidate.id]),
      conflictActions: new Map(),
      envOverrides: [
        {
          candidateId: candidate.id,
          fieldKind: "header",
          fieldKey: "Authorization",
          envVar: "API_BEARER"
        }
      ]
    }
  });

  assert.equal(result.configWritten, true);
  const yaml = await readFile(configPath, "utf8");
  assert.match(yaml, /Authorization: Bearer \{env:API_BEARER\}/);
});

test("possible duplicates report cross-source MCPs that share runtime identity", async () => {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), "agentport-cross-source-dup-"));
  await writeText(
    path.join(sourceDir, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        primary: {
          type: "http",
          url: "https://api.example.com/mcp",
          headers: { Authorization: "claude-secret" }
        }
      }
    })
  );
  await writeText(
    path.join(sourceDir, ".cursor", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        cursorAlias: {
          type: "http",
          url: "https://api.example.com/mcp/",
          headers: { Authorization: "cursor-secret" }
        }
      }
    })
  );

  const configDir = await makeConfigDir();
  const configPath = path.join(configDir, "agentkit.yml");

  const result = await importProject({
    configPath,
    sourceDir,
    sources: ["claude", "cursor"],
    categories: ["mcp"]
  });

  assert.equal(result.imported.length, 2);
  assert.equal(result.possibleDuplicates.length, 1);
  const duplicate = result.possibleDuplicates[0]!;
  assert.equal(duplicate.importedName, "cursorAlias");
  assert.equal(duplicate.existingName, "primary");
  assert.doesNotMatch(duplicate.message, /claude-secret|cursor-secret/);
});

test("possible duplicates flag a replaced MCP that now matches a later base alias", async () => {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), "agentport-replace-later-alias-"));
  await writeText(
    path.join(sourceDir, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        main: {
          type: "http",
          url: "https://api.example.com/mcp",
          headers: { Authorization: "imported-secret" }
        }
      }
    })
  );

  const configDir = await makeConfigDir();
  const configPath = path.join(configDir, "agentkit.yml");
  await writeText(
    configPath,
    `version: 1
mcpServers:
  - name: main
    transport: http
    url: https://other.example.com/mcp
    headers:
      Authorization: existing-secret
  - name: alias
    transport: http
    url: https://api.example.com/mcp
    headers:
      Authorization: alias-secret
`
  );

  const plan = await planImport({
    configPath,
    sourceDir,
    sources: ["claude"],
    categories: ["mcp"]
  });
  const candidate = plan.candidates[0]!;
  assert.equal(candidate.classification.kind, "conflict");

  const result = await applyImportPlan({
    plan,
    selection: {
      selectedIds: new Set([candidate.id]),
      conflictActions: new Map([[candidate.id, { type: "replace" } as ConflictAction]])
    }
  });

  assert.equal(result.configWritten, true);
  assert.equal(result.possibleDuplicates.length, 1);
  const duplicate = result.possibleDuplicates[0]!;
  assert.equal(duplicate.importedName, "main");
  assert.equal(duplicate.existingName, "alias");
  assert.doesNotMatch(duplicate.message, /imported-secret|existing-secret|alias-secret/);
});

test("possible duplicates do not surface for deselected new MCP candidates", async () => {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), "agentport-deselect-dup-"));
  await writeText(
    path.join(sourceDir, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        wanted: {
          type: "http",
          url: "https://api.example.com/mcp",
          headers: { Authorization: "wanted-secret" }
        },
        unwanted: {
          type: "http",
          url: "https://api.example.com/mcp",
          headers: { Authorization: "unwanted-secret" }
        }
      }
    })
  );

  const configDir = await makeConfigDir();
  const configPath = path.join(configDir, "agentkit.yml");

  const plan = await planImport({
    configPath,
    sourceDir,
    sources: ["claude"],
    categories: ["mcp"]
  });

  const wanted = plan.candidates.find((c) => c.id === "mcp:claude:wanted")!;
  const result = await applyImportPlan({
    plan,
    selection: {
      selectedIds: new Set([wanted.id]),
      conflictActions: new Map()
    }
  });

  assert.equal(result.imported.length, 1);
  assert.equal(result.possibleDuplicates.length, 0);
});

test("preserved {env:NAME} placeholder values still produce env action items in result", async () => {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), "agentport-preserved-placeholder-"));
  await writeText(
    path.join(sourceDir, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        existing: {
          type: "http",
          url: "https://api.example.com/mcp",
          headers: {
            Authorization: "{env:EXISTING_AUTH}",
            "X-Tenant": "{env:EXISTING_TENANT}"
          }
        }
      }
    })
  );

  const configDir = await makeConfigDir();
  const configPath = path.join(configDir, "agentkit.yml");

  const result = await importProject({
    configPath,
    sourceDir,
    sources: ["claude"],
    categories: ["mcp"]
  });

  assert.equal(result.imported.length, 1);
  const reasons = result.envActionItems
    .filter((item) => item.itemName === "existing")
    .map((item) => item.reason);
  assert.equal(reasons.filter((reason) => reason === "preserved-placeholder").length, 2);
  const envVars = result.envActionItems.map((item) => item.envVar);
  assert.ok(envVars.includes("EXISTING_AUTH"));
  assert.ok(envVars.includes("EXISTING_TENANT"));
});

test("non-interactive importProject with --env-policy preserve does not rewrite literals", async () => {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), "agentport-policy-preserve-"));
  await writeText(
    path.join(sourceDir, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        api: {
          type: "http",
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer abcdef" }
        }
      }
    })
  );
  const configDir = await makeConfigDir();
  const configPath = path.join(configDir, "agentkit.yml");

  const plan = await planImport({
    configPath,
    sourceDir,
    sources: ["claude"],
    categories: ["mcp"]
  });

  const candidate = plan.candidates[0]!;
  assert.equal(
    (candidate.item as { headers?: Record<string, string> }).headers?.Authorization,
    "Bearer abcdef"
  );
});
