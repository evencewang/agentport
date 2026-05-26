import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadConfig, resolveConfig } from "./config.js";
import { renderTarget } from "./render.js";
import { type BuildOptions, type BuildWarning, type Target } from "./types.js";

export interface PlannedOutput {
  target: Target;
  relativeFilePath: string;
  filePath: string;
  content: string;
}

export interface BuildPlan {
  targets: Target[];
  outputs: PlannedOutput[];
  warnings: BuildWarning[];
}

export interface BuildResult {
  writtenFiles: string[];
  plannedFiles: string[];
  outputs: PlannedOutput[];
  warnings: BuildWarning[];
  targets: Target[];
}

export async function createBuildPlan(options: BuildOptions): Promise<BuildPlan> {
  const config = await loadConfig(options.configPath);
  const resolved = resolveConfig(config, {
    profile: options.profile,
    targets: options.targets,
    allTargets: options.allTargets
  });
  const outputs: PlannedOutput[] = [];
  const warnings: BuildWarning[] = [];

  for (const target of resolved.targets) {
    const rendered = renderTarget(target, resolved.config);
    warnings.push(...rendered.warnings);

    for (const [relativeFilePath, content] of Object.entries(rendered.files).sort(([a], [b]) =>
      a.localeCompare(b)
    )) {
      outputs.push({
        target,
        relativeFilePath,
        filePath: path.join(options.outDir, target, relativeFilePath),
        content
      });
    }
  }

  return { targets: resolved.targets, outputs, warnings };
}

export function formatStdoutOutputs(outputs: PlannedOutput[]): string {
  return outputs
    .map((output) => `=== ${output.target}/${output.relativeFilePath} ===\n${output.content}`)
    .join("\n");
}

export async function buildProject(options: BuildOptions): Promise<BuildResult> {
  const plan = await createBuildPlan(options);
  const writtenFiles: string[] = [];
  const shouldWrite = !options.dryRun && !options.stdout;

  if (shouldWrite) {
    for (const output of plan.outputs) {
      await mkdir(path.dirname(output.filePath), { recursive: true });
      await writeFile(output.filePath, output.content, "utf8");
      writtenFiles.push(output.filePath);
    }
  }

  return {
    writtenFiles,
    plannedFiles: plan.outputs.map((output) => output.filePath),
    outputs: plan.outputs,
    warnings: plan.warnings,
    targets: plan.targets
  };
}
