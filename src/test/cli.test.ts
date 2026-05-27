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

test("import validates supported source/category flags", async () => {
  await expectCliError(
    ["import", "--from", "unknown", "--include", "all", "--dry-run"],
    /Unsupported import source "unknown"/
  );
  await expectCliError(
    ["import", "--from", "claude", "--include", "rules", "--dry-run"],
    /Unsupported import category "rules"/
  );
});

test("import CLI accepts explicit scope and compatibility flag when nothing is importable", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "agentport-cli-import-empty-"));

  const result = await execFileAsync(
    process.execPath,
    [cliPath, "import", "--interactive", "--from", "claude", "--include", "commands", "--dry-run"],
    { cwd }
  );

  assert.match(result.stdout, /No importable items discovered/);
  assert.match(result.stdout, /Nothing to import\. agentkit\.yml not written\./);
});

test("import CLI requires a terminal when interactive selection is needed", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "agentport-cli-requires-tty-"));
  await mkdir(path.join(cwd, ".claude", "commands"), { recursive: true });
  await writeFile(path.join(cwd, ".claude", "commands", "review.md"), "Review.\n", "utf8");

  await assert.rejects(
    () =>
      execFileAsync(
        process.execPath,
        [cliPath, "import", "--from", "claude", "--include", "commands", "--dry-run"],
        { cwd }
      ),
    (error: unknown) => {
      const execError = error as ExecFileError & { stdout?: string };
      const output = `${execError.stdout ?? ""}${execError.stderr ?? ""}`;
      assert.match(output, /Interactive import requires an interactive terminal\./);
      return true;
    }
  );
});
