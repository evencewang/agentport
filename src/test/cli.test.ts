import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cliPath = path.join(process.cwd(), "dist", "cli.js");

interface ExecFileError extends Error {
  stderr?: string;
}

async function expectCliError(args: string[], expectedStderr: RegExp): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "agentport-cli-"));

  await assert.rejects(
    () => execFileAsync(process.execPath, [cliPath, ...args], { cwd }),
    (error: unknown) => {
      const stderr = (error as ExecFileError).stderr ?? "";
      assert.match(stderr, expectedStderr);
      assert.match(stderr, /Run agentport --help for usage\./);
      return true;
    }
  );
}

test("init reads bundled template when run outside the package directory", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "agentport-init-"));
  const configPath = path.join(cwd, "agentkit.yml");

  const result = await execFileAsync(process.execPath, [cliPath, "init"], { cwd });

  assert.match(result.stdout, /Wrote agentkit\.yml/);
  const contents = await readFile(configPath, "utf8");
  assert.match(contents, /version: 1/);
  assert.match(contents, /universal-core/);
});

test("CLI rejects unknown flags and stray arguments deterministically", async () => {
  await expectCliError(["build", "--profle", "core"], /Unknown option "--profle"/);
  await expectCliError(["build", "unexpected"], /Unexpected argument "unexpected"/);
});

test("build reports missing default config with init guidance", async () => {
  await expectCliError(
    ["build", "--dry-run"],
    /No config file found at agentkit\.yml\. Run agentport init to create one, or pass --config <path>\./
  );
});

test("import validates required and supported source/category flags", async () => {
  await expectCliError(["import", "--include", "all", "--dry-run"], /Missing --from/);
  await expectCliError(["import", "--from", "claude", "--dry-run"], /Missing --include/);
  await expectCliError(
    ["import", "--from", "unknown", "--include", "all", "--dry-run"],
    /Unsupported import source "unknown"/
  );
  await expectCliError(
    ["import", "--from", "claude", "--include", "rules", "--dry-run"],
    /Unsupported import category "rules"/
  );
});

test("import accepts repeated and comma-separated source/category flags", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "agentport-cli-import-"));
  await mkdir(path.join(cwd, ".claude", "commands"), { recursive: true });
  await writeFile(path.join(cwd, ".claude", "commands", "review.md"), "Review.\n", "utf8");

  const result = await execFileAsync(
    process.execPath,
    [
      cliPath,
      "import",
      "--from",
      "claude,cursor",
      "--from",
      "opencode",
      "--include",
      "mcp,commands",
      "--include",
      "skills",
      "--dry-run"
    ],
    { cwd }
  );

  assert.match(result.stdout, /Sources: claude, cursor, opencode/);
  assert.match(result.stdout, /Categories: mcp, skills, commands/);
  assert.match(result.stdout, /commands: imported 1/);
});

test("import CLI reports supported-but-empty discovery combinations", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "agentport-cli-import-empty-"));

  const result = await execFileAsync(
    process.execPath,
    [cliPath, "import", "--from", "claude", "--include", "commands", "--dry-run"],
    { cwd }
  );

  assert.match(result.stdout, /commands: imported 0/);
  assert.match(result.stdout, /\[discovery:commands\] claude: 0 discovered/);
  assert.match(result.stdout, /Nothing changed/);
});

test("import CLI reports MCP conflicts and possible duplicates without secret values", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "agentport-cli-import-mcp-redaction-"));
  await writeFile(
    path.join(cwd, "agentkit.yml"),
    `version: 1
mcpServers:
  - name: context7
    transport: http
    url: https://mcp.context7.com/mcp
    headers:
      Authorization: existing-secret
`,
    "utf8"
  );
  await writeFile(
    path.join(cwd, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        context7: {
          type: "http",
          url: "https://mcp.context7.com/other",
          headers: { Authorization: "imported-secret" }
        },
        context7Alias: {
          type: "http",
          url: "https://mcp.context7.com/mcp/",
          headers: { Authorization: "alias-secret" }
        }
      }
    }),
    "utf8"
  );

  await assert.rejects(
    () =>
      execFileAsync(
        process.execPath,
        [cliPath, "import", "--from", "claude", "--include", "mcp"],
        { cwd }
      ),
    (error: unknown) => {
      const execError = error as ExecFileError & { stdout?: string };
      const output = `${execError.stdout ?? ""}${execError.stderr ?? ""}`;
      assert.match(output, /\[conflict:mcp\]/);
      assert.match(output, /\[possible-duplicate:mcp\]/);
      assert.match(output, /header-like values/);
      assert.doesNotMatch(output, /existing-secret|imported-secret|alias-secret/);
      return true;
    }
  );
});
