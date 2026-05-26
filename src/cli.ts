#!/usr/bin/env node

import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildProject, formatStdoutOutputs } from "./build.js";
import {
  assertValidImportCategories,
  assertValidImportSources,
  importProject,
  type ImportResult
} from "./import.js";
import { TARGETS, type BuildOptions, type Target } from "./types.js";

const DEFAULT_CONFIG_PATH = "agentkit.yml";
const DEFAULT_OUT_DIR = ".generated";
const HELP_HINT = "Run agentport --help for usage.";
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLE_CONFIG_PATH = path.join(PACKAGE_ROOT, "examples", "basic.agentkit.yml");

type FlagKind = "boolean" | "value";

function printHelp(): void {
  console.log(`agentport

Usage:
  agentport init [--config path]
  agentport build [--config path] [--out dir] [--profile name]
                  [--target claude,codex,cursor,opencode] [--all-targets]
                  [--dry-run | --stdout]
  agentport import --from claude,cursor --include mcp,skills,commands
                   [--config path] [--source-dir dir] [--dry-run]

Options:
  --profile <name>     Build using a named profile from agentkit.yml.
  --target <targets>   Build selected targets. Repeat or comma-separate values.
  --all-targets        Build every supported target, overriding profile defaults.
  --dry-run            Render and list planned files without writing them.
  --stdout             Print generated files with headings without writing them.
  --from <sources>     Import from claude, cursor, opencode, and/or codex.
  --include <items>    Import mcp, skills, commands, or all.
  --source-dir <dir>   Source directory to scan for import inputs.

Examples:
  agentport init
  agentport build
  agentport build --target claude,cursor --out .generated
  agentport build --profile core --target claude --dry-run
  agentport build --profile core --all-targets --stdout
  agentport import --from claude --include all --dry-run
`);
}

function uniqueValues(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const value of values) {
    if (!seen.has(value)) {
      unique.push(value);
      seen.add(value);
    }
  }

  return unique;
}

function parseCommaSeparatedValues(inputs: string[]): string[] {
  return uniqueValues(
    inputs.flatMap((input) =>
      input
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    )
  );
}

function parseTargets(inputs: string[]): Target[] | undefined {
  if (inputs.length === 0) {
    return undefined;
  }

  const targets = parseCommaSeparatedValues(inputs);
  if (targets.length === 0) {
    throw new Error(`Expected at least one target. ${HELP_HINT}`);
  }

  for (const target of targets) {
    if (!TARGETS.includes(target as Target)) {
      throw new Error(
        `Unsupported target "${target}". Supported targets: ${TARGETS.join(", ")}. ${HELP_HINT}`
      );
    }
  }

  return targets as Target[];
}

function validateArgs(args: string[], allowedFlags: Partial<Record<string, FlagKind>>): void {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument "${arg}". ${HELP_HINT}`);
    }

    const kind = allowedFlags[arg];
    if (!kind) {
      throw new Error(`Unknown option "${arg}". ${HELP_HINT}`);
    }

    if (kind === "value") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Expected value after ${arg}. ${HELP_HINT}`);
      }

      index += 1;
    }
  }
}

function getFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Expected value after ${flag}. ${HELP_HINT}`);
  }

  return value;
}

function getFlagValues(args: string[], flag: string): string[] {
  const values: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== flag) {
      continue;
    }

    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Expected value after ${flag}. ${HELP_HINT}`);
    }

    values.push(value);
    index += 1;
  }

  return values;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function runInit(args: string[]): Promise<void> {
  validateArgs(args, { "--config": "value" });

  const configPath = getFlagValue(args, "--config") ?? DEFAULT_CONFIG_PATH;

  if (await fileExists(configPath)) {
    throw new Error(`Refusing to overwrite existing file: ${configPath}`);
  }

  const example = await readFile(EXAMPLE_CONFIG_PATH, "utf8");
  await writeFile(configPath, example, "utf8");
  console.log(`Wrote ${configPath}`);
}

async function runBuild(args: string[]): Promise<void> {
  validateArgs(args, {
    "--config": "value",
    "--out": "value",
    "--profile": "value",
    "--target": "value",
    "--all-targets": "boolean",
    "--dry-run": "boolean",
    "--stdout": "boolean"
  });

  const targetInputs = getFlagValues(args, "--target");
  const profileInputs = getFlagValues(args, "--profile");
  const allTargets = hasFlag(args, "--all-targets");
  const dryRun = hasFlag(args, "--dry-run");
  const stdout = hasFlag(args, "--stdout");

  if (allTargets && targetInputs.length > 0) {
    throw new Error(`Use either --target or --all-targets, not both. ${HELP_HINT}`);
  }

  if (dryRun && stdout) {
    throw new Error(`Use either --dry-run or --stdout, not both. ${HELP_HINT}`);
  }

  if (profileInputs.length > 1) {
    throw new Error(`Use only one --profile value per build. ${HELP_HINT}`);
  }

  const options: BuildOptions = {
    configPath: getFlagValue(args, "--config") ?? DEFAULT_CONFIG_PATH,
    outDir: getFlagValue(args, "--out") ?? DEFAULT_OUT_DIR,
    targets: parseTargets(targetInputs),
    profile: profileInputs[0],
    allTargets,
    dryRun,
    stdout
  };

  if (!(await fileExists(options.configPath))) {
    throw new Error(
      `No config file found at ${options.configPath}. Run agentport init to create one, or pass --config <path>. ${HELP_HINT}`
    );
  }

  const result = await buildProject(options);

  if (stdout) {
    const output = formatStdoutOutputs(result.outputs);
    if (output) {
      process.stdout.write(output);
      if (!output.endsWith("\n")) {
        process.stdout.write("\n");
      }
    }
  } else if (dryRun) {
    for (const filePath of result.plannedFiles) {
      console.log(`Would write ${filePath}`);
    }
  } else {
    for (const filePath of result.writtenFiles) {
      console.log(`Wrote ${filePath}`);
    }
  }

  for (const warning of result.warnings) {
    console.warn(`[${warning.target}] ${warning.message}`);
  }
}

function printImportResult(result: ImportResult): void {
  console.log(`Sources: ${result.sources.join(", ")}`);
  console.log(`Categories: ${result.categories.join(", ")}`);
  if (result.dryRun) {
    console.log(`Dry run: would update ${result.configPath}`);
  }

  for (const category of result.categories) {
    const counts = result.countsByCategory[category];
    const merged = result.merged.filter((item) => item.category === category).length;
    const possibleDuplicates = result.possibleDuplicates.filter(
      (item) => item.category === category
    ).length;
    console.log(
      `${category}: imported ${counts.imported}, skipped ${counts.skipped}, unchanged ${counts.unchanged}, merged ${merged}, conflicts ${counts.conflicts}, possible duplicates ${possibleDuplicates}, warnings ${counts.warnings}`
    );
  }

  for (const discovery of result.discovery) {
    console.log(
      `[discovery:${discovery.category}] ${discovery.source}: ${discovery.discovered} discovered${
        discovery.supported ? "" : ` (${discovery.reason})`
      }`
    );
  }

  for (const skipped of result.skipped) {
    console.log(`[skipped:${skipped.category}] ${skipped.source}: ${skipped.reason}`);
  }

  for (const warning of result.warnings) {
    console.warn(`[warning:${warning.category}] ${warning.message}`);
  }

  for (const merged of result.merged) {
    console.log(`[merged:${merged.category}] ${merged.message}`);
  }

  for (const duplicate of result.possibleDuplicates) {
    console.warn(`[possible-duplicate:${duplicate.category}] ${duplicate.message}`);
  }

  for (const conflict of result.conflicts) {
    console.error(`[conflict:${conflict.category}] ${conflict.message}`);
  }

  if (result.conflicts.length > 0) {
    throw new Error(`Import has ${result.conflicts.length} conflict(s); ${result.configPath} was not written.`);
  }

  if (result.configWritten) {
    console.log(`Wrote ${result.configPath}`);
  } else if (!result.configChanged) {
    console.log("Nothing changed");
  }
}

async function runImport(args: string[]): Promise<void> {
  validateArgs(args, {
    "--from": "value",
    "--include": "value",
    "--config": "value",
    "--source-dir": "value",
    "--dry-run": "boolean"
  });

  const sources = assertValidImportSources(parseCommaSeparatedValues(getFlagValues(args, "--from")));
  const categories = assertValidImportCategories(
    parseCommaSeparatedValues(getFlagValues(args, "--include"))
  );
  const configPath = getFlagValue(args, "--config") ?? DEFAULT_CONFIG_PATH;
  const sourceDir = getFlagValue(args, "--source-dir") ?? process.cwd();

  const result = await importProject({
    configPath,
    sourceDir,
    sources,
    categories,
    dryRun: hasFlag(args, "--dry-run")
  });

  printImportResult(result);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "init") {
    await runInit(args.slice(1));
    return;
  }

  if (command === "build") {
    await runBuild(args.slice(1));
    return;
  }

  if (command === "import") {
    await runImport(args.slice(1));
    return;
  }

  throw new Error(`Unknown command "${command}". ${HELP_HINT}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
