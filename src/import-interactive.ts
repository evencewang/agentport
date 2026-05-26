import {
  applyImportPlan,
  planImport,
  summarizeItemRedacted,
  type ConflictAction,
  type DiscoveredItem,
  type EnvOverride,
  type ImportPlan,
  type ImportResult,
  type ResolvedSelection
} from "./import.js";
import {
  INTERACTIVE_ENV_POLICY,
  type EnvActionItem,
  type EnvPolicy
} from "./import-env.js";
import {
  isCancelled,
  type PromptAdapter,
  type PromptOption
} from "./import-prompts.js";
import {
  IMPORT_CATEGORIES,
  IMPORT_SOURCES,
  type ConcreteImportCategory,
  type ImportCategory,
  type ImportSource
} from "./types.js";

const CATEGORY_LABELS: Record<ConcreteImportCategory, string> = {
  mcp: "MCP servers",
  skills: "Skills",
  commands: "Commands"
};

export interface InteractiveImportOptions {
  configPath: string;
  sourceDir: string;
  sources?: ImportSource[];
  categories?: ImportCategory[];
  dryRun?: boolean;
  envPolicy?: EnvPolicy;
  adapter: PromptAdapter;
}

export interface InteractiveImportOutcome {
  cancelled: boolean;
  plan?: ImportPlan;
  result?: ImportResult;
}

function expand(values: ImportCategory[] | undefined): ConcreteImportCategory[] | undefined {
  if (!values) {
    return undefined;
  }
  if (values.includes("all")) {
    return ["mcp", "skills", "commands"];
  }
  return values.filter((value): value is ConcreteImportCategory => value !== "all");
}

async function promptSources(
  adapter: PromptAdapter,
  initial: ImportSource[] | undefined
): Promise<ImportSource[] | undefined> {
  if (initial && initial.length > 0) {
    return initial;
  }

  const options: PromptOption<ImportSource>[] = IMPORT_SOURCES.map((source) => ({
    value: source,
    label: source
  }));

  const value = await adapter.multiselect<ImportSource>({
    message: "Select source tools to import from",
    options,
    required: true
  });

  if (isCancelled(value)) {
    return undefined;
  }
  return value;
}

async function promptCategories(
  adapter: PromptAdapter,
  initial: ImportCategory[] | undefined
): Promise<ConcreteImportCategory[] | undefined> {
  const expanded = expand(initial);
  if (expanded && expanded.length > 0) {
    return expanded;
  }

  const options: PromptOption<ConcreteImportCategory>[] = (
    IMPORT_CATEGORIES.filter((value) => value !== "all") as ConcreteImportCategory[]
  ).map((category) => ({
    value: category,
    label: CATEGORY_LABELS[category]
  }));

  const value = await adapter.multiselect<ConcreteImportCategory>({
    message: "Select item categories to import",
    options,
    required: true
  });

  if (isCancelled(value)) {
    return undefined;
  }
  return value;
}

function describeCandidate(candidate: DiscoveredItem): string {
  const summary = summarizeItemRedacted(candidate.category, candidate.item);
  const status = describeClassification(candidate);
  return `${candidate.item.name} [${candidate.source}] (${status}) — ${summary}`;
}

function describeClassification(candidate: DiscoveredItem): string {
  switch (candidate.classification.kind) {
    case "new":
      return "new";
    case "merge":
      return `merge targets +${candidate.classification.mergedTargets.join(", ")}`;
    case "unchanged":
      return "unchanged";
    case "conflict":
      return "conflict";
  }
}

interface CategorySelectionResult {
  selected: Set<string>;
  cancelled: boolean;
}

async function selectCategoryItems(
  adapter: PromptAdapter,
  category: ConcreteImportCategory,
  candidates: DiscoveredItem[],
  previousSelection: Set<string> | undefined
): Promise<CategorySelectionResult> {
  if (candidates.length === 0) {
    return { selected: new Set(), cancelled: false };
  }

  const eligible = candidates.filter(
    (candidate) => candidate.classification.kind !== "unchanged"
  );

  if (eligible.length === 0) {
    return { selected: new Set(), cancelled: false };
  }

  const options: PromptOption<string>[] = eligible.map((candidate) => ({
    value: candidate.id,
    label: describeCandidate(candidate),
    ...(candidate.possibleDuplicates.length > 0
      ? { hint: `possible duplicate of ${candidate.possibleDuplicates[0]!.existingName}` }
      : {})
  }));

  const initial = previousSelection
    ? eligible.filter((candidate) => previousSelection.has(candidate.id)).map((c) => c.id)
    : eligible.map((candidate) => candidate.id);

  const result = await adapter.multiselect<string>({
    message: `Select ${CATEGORY_LABELS[category]} to import`,
    options,
    initialValues: initial
  });

  if (isCancelled(result)) {
    return { selected: new Set(), cancelled: true };
  }

  return { selected: new Set(result), cancelled: false };
}

interface ConflictPromptResult {
  action: ConflictAction;
  cancelled: boolean;
}

async function promptConflict(
  adapter: PromptAdapter,
  candidate: DiscoveredItem,
  workingNames: Set<string>,
  currentAction: ConflictAction | undefined
): Promise<ConflictPromptResult> {
  if (candidate.classification.kind !== "conflict") {
    return { action: { type: "skip" }, cancelled: false };
  }

  const conflict = candidate.classification;
  adapter.note(
    [
      `Conflict in ${CATEGORY_LABELS[candidate.category]}: "${candidate.item.name}"`,
      `existing: ${conflict.existingSummary}`,
      `imported: ${conflict.incomingSummary}`,
      `differs by: ${conflict.differenceDimensions.join(", ")}`,
      ...(currentAction ? [`current: ${describeConflictAction(currentAction)}`] : [])
    ].join("\n")
  );

  const options: PromptOption<ConflictAction["type"]>[] = [
    { value: "keep", label: "Keep existing (skip imported)" },
    { value: "replace", label: "Replace existing with imported" },
    { value: "rename", label: "Import as renamed copy" }
  ];

  if (candidate.category === "mcp" && conflict.safeMergeAvailable) {
    options.push({ value: "merge", label: "Safe merge MCP fields" });
  }
  options.push({ value: "abort", label: "Abort import without writing" });

  const choice = await adapter.select<ConflictAction["type"]>({
    message: `Resolve conflict for ${candidate.item.name}`,
    options,
    ...(currentAction ? { initialValue: currentAction.type } : {})
  });

  if (isCancelled(choice)) {
    return { action: { type: "abort" }, cancelled: true };
  }

  if (choice === "rename") {
    const defaultName =
      currentAction?.type === "rename" ? currentAction.newName : `${candidate.item.name}-imported`;
    const newName = await adapter.text({
      message: `New name for ${candidate.item.name}`,
      initialValue: defaultName,
      validate: (value) => {
        const trimmed = value.trim();
        if (!trimmed) {
          return "Name cannot be empty";
        }
        if (workingNames.has(trimmed)) {
          return `An item named "${trimmed}" already exists in ${CATEGORY_LABELS[candidate.category]}`;
        }
        return undefined;
      }
    });
    if (isCancelled(newName)) {
      return { action: { type: "abort" }, cancelled: true };
    }
    return { action: { type: "rename", newName: newName.trim() }, cancelled: false };
  }

  if (choice === "merge") {
    return { action: { type: "merge" }, cancelled: false };
  }

  return { action: { type: choice as ConflictAction["type"] } as ConflictAction, cancelled: false };
}

function describeConflictAction(action: ConflictAction): string {
  switch (action.type) {
    case "keep":
      return "keep existing";
    case "replace":
      return "replace existing";
    case "rename":
      return `rename to ${action.newName}`;
    case "merge":
      return "safe merge";
    case "skip":
      return "skip";
    case "abort":
      return "abort";
  }
}

function buildPreview(plan: ImportPlan, selection: ResolvedSelection): string {
  const lines: string[] = [];
  lines.push(`Config: ${plan.configPath}`);
  lines.push(`Sources: ${plan.sources.join(", ")}`);
  lines.push(`Categories: ${plan.categories.join(", ")}`);

  const overrideMap = new Map<string, EnvOverride>();
  for (const override of selection.envOverrides ?? []) {
    overrideMap.set(
      `${override.candidateId}::${override.fieldKind}:${override.fieldKey}`,
      override
    );
  }

  for (const category of plan.categories) {
    const candidates = plan.candidates.filter((candidate) => candidate.category === category);
    const selected = candidates.filter((candidate) => selection.selectedIds.has(candidate.id));
    const conflictsActioned = candidates.filter(
      (candidate) =>
        candidate.classification.kind === "conflict" && selection.conflictActions.has(candidate.id)
    );
    lines.push(
      `- ${CATEGORY_LABELS[category]}: ${selected.length}/${candidates.length} selected, conflicts ${conflictsActioned.length}`
    );
  }

  const finalActionItems: string[] = [];
  for (const candidate of plan.candidates) {
    if (!selection.selectedIds.has(candidate.id)) {
      continue;
    }
    if (candidate.classification.kind === "conflict") {
      const action = selection.conflictActions.get(candidate.id);
      if (!action || action.type === "keep" || action.type === "skip" || action.type === "abort") {
        continue;
      }
    }
    for (const action of candidate.envActionItems) {
      const key = `${candidate.id}::${action.field.kind}:${action.field.key}`;
      const overrideVar = overrideMap.get(key)?.envVar;
      const message =
        overrideVar && overrideVar !== action.envVar
          ? action.message.replace(action.envVar, overrideVar)
          : action.message;
      finalActionItems.push(message);
    }
  }

  if (finalActionItems.length > 0) {
    lines.push("Env action items:");
    for (const message of finalActionItems) {
      lines.push(`  • ${message}`);
    }
  }

  if (plan.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of plan.warnings) {
      lines.push(`  • ${warning.message}`);
    }
  }

  return lines.join("\n");
}

async function reviewSelection(
  adapter: PromptAdapter,
  plan: ImportPlan
): Promise<ResolvedSelection | undefined> {
  const selectedIds = new Set<string>();
  const conflictActions = new Map<string, ConflictAction>();
  const envOverrides = new Map<string, EnvOverride>();
  const candidatesByCategory = new Map<ConcreteImportCategory, DiscoveredItem[]>();
  for (const category of plan.categories) {
    candidatesByCategory.set(
      category,
      plan.candidates.filter((candidate) => candidate.category === category)
    );
  }

  let isFirstPass = true;
  while (true) {
    for (const category of plan.categories) {
      const candidates = candidatesByCategory.get(category) ?? [];
      if (candidates.length === 0) {
        continue;
      }

      const previous = isFirstPass ? undefined : new Set(selectedIds);
      const result = await selectCategoryItems(adapter, category, candidates, previous);
      if (result.cancelled) {
        return undefined;
      }

      for (const candidate of candidates) {
        if (candidate.classification.kind === "unchanged") {
          continue;
        }
        if (result.selected.has(candidate.id)) {
          selectedIds.add(candidate.id);
        } else {
          selectedIds.delete(candidate.id);
          conflictActions.delete(candidate.id);
        }
      }
    }
    isFirstPass = false;

    const conflictsToResolve = plan.candidates.filter(
      (candidate) =>
        candidate.classification.kind === "conflict" && selectedIds.has(candidate.id)
    );

    let aborted = false;
    for (const candidate of conflictsToResolve) {
      const existingNames = new Set(
        plan.candidates
          .filter((other) => other.category === candidate.category && other.id !== candidate.id)
          .map((other) => other.item.name)
      );
      const baseExisting = (() => {
        if (candidate.category === "mcp") {
          return plan.baseConfig.mcpServers ?? [];
        }
        if (candidate.category === "skills") {
          return plan.baseConfig.skills ?? [];
        }
        return plan.baseConfig.commands ?? [];
      })();
      for (const existing of baseExisting) {
        existingNames.add(existing.name);
      }

      const currentAction = conflictActions.get(candidate.id);
      const result = await promptConflict(adapter, candidate, existingNames, currentAction);
      if (result.cancelled) {
        return undefined;
      }
      if (result.action.type === "abort") {
        aborted = true;
        break;
      }
      conflictActions.set(candidate.id, result.action);
    }

    if (aborted) {
      return undefined;
    }

    const overrideCancelled = await collectEnvOverrides(
      adapter,
      plan,
      selectedIds,
      conflictActions,
      envOverrides
    );
    if (overrideCancelled) {
      return undefined;
    }

    const overridesArray = [...envOverrides.values()];
    adapter.note(
      buildPreview(plan, { selectedIds, conflictActions, envOverrides: overridesArray })
    );

    const navigationOptions: PromptOption<"confirm" | "revisit" | "cancel">[] = [
      { value: "confirm", label: "Confirm and write agentkit.yml" },
      { value: "revisit", label: "Revisit category selections and conflicts" },
      { value: "cancel", label: "Cancel without writing" }
    ];

    const decision = await adapter.select<"confirm" | "revisit" | "cancel">({
      message: "Ready to write?",
      options: navigationOptions,
      initialValue: "confirm"
    });

    if (isCancelled(decision) || decision === "cancel") {
      return undefined;
    }
    if (decision === "confirm") {
      return {
        selectedIds,
        conflictActions,
        envOverrides: overridesArray
      };
    }
  }
}

function effectiveEnvVar(
  candidateId: string,
  action: EnvActionItem,
  overrides: Map<string, EnvOverride>
): string {
  const key = `${candidateId}::${action.field.kind}:${action.field.key}`;
  return overrides.get(key)?.envVar ?? action.envVar;
}

function isOverridableReason(reason: EnvActionItem["reason"]): boolean {
  return (
    reason === "literal-secret" ||
    reason === "masked-secret" ||
    reason === "shell-var" ||
    reason === "env-http-headers" ||
    reason === "bearer-token"
  );
}

async function collectEnvOverrides(
  adapter: PromptAdapter,
  plan: ImportPlan,
  selectedIds: Set<string>,
  conflictActions: Map<string, ConflictAction>,
  envOverrides: Map<string, EnvOverride>
): Promise<boolean> {
  const proposals: Array<{ candidate: DiscoveredItem; action: EnvActionItem }> = [];
  for (const candidate of plan.candidates) {
    if (candidate.envActionItems.length === 0) {
      continue;
    }
    const willWrite =
      candidate.classification.kind === "new"
        ? selectedIds.has(candidate.id)
        : candidate.classification.kind === "conflict"
          ? selectedIds.has(candidate.id) &&
            (conflictActions.get(candidate.id)?.type === "replace" ||
              conflictActions.get(candidate.id)?.type === "rename")
          : false;
    if (!willWrite) {
      continue;
    }
    for (const action of candidate.envActionItems) {
      if (isOverridableReason(action.reason)) {
        proposals.push({ candidate, action });
      }
    }
  }

  if (proposals.length === 0) {
    return false;
  }

  const reviewChoice = await adapter.select<"keep" | "edit">({
    message: `Review ${proposals.length} proposed env var name(s)?`,
    options: [
      { value: "keep", label: "Accept proposed env var names" },
      { value: "edit", label: "Edit env var names individually" }
    ],
    initialValue: "keep"
  });

  if (isCancelled(reviewChoice)) {
    return true;
  }
  if (reviewChoice === "keep") {
    return false;
  }

  for (const { candidate, action } of proposals) {
    const fieldDesc = action.field.kind === "env" ? `env.${action.field.key}` : `headers.${action.field.key}`;
    const current = effectiveEnvVar(candidate.id, action, envOverrides);
    const next = await adapter.text({
      message: `Env var for ${candidate.item.name} ${fieldDesc}`,
      initialValue: current,
      validate: (value) => {
        const trimmed = value.trim();
        if (!trimmed) {
          return "Env var name cannot be empty";
        }
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
          return "Env var name must match ^[A-Za-z_][A-Za-z0-9_]*$";
        }
        return undefined;
      }
    });
    if (isCancelled(next)) {
      return true;
    }
    const trimmed = next.trim();
    if (trimmed && trimmed !== action.envVar) {
      envOverrides.set(`${candidate.id}::${action.field.kind}:${action.field.key}`, {
        candidateId: candidate.id,
        fieldKind: action.field.kind,
        fieldKey: action.field.key,
        envVar: trimmed
      });
    } else {
      envOverrides.delete(`${candidate.id}::${action.field.kind}:${action.field.key}`);
    }
  }

  return false;
}

function summarizeEnvActionItems(items: EnvActionItem[]): string {
  if (items.length === 0) {
    return "No env action items.";
  }
  const lines = ["Env action items:"];
  for (const item of items) {
    lines.push(`  • ${item.message}`);
  }
  return lines.join("\n");
}

export async function runInteractiveImport(
  options: InteractiveImportOptions
): Promise<InteractiveImportOutcome> {
  const { adapter } = options;
  adapter.start("agentport import (interactive)");

  const sources = await promptSources(adapter, options.sources);
  if (!sources) {
    adapter.cancel("Cancelled before source selection. agentkit.yml not written.");
    return { cancelled: true };
  }

  const categories = await promptCategories(adapter, options.categories);
  if (!categories) {
    adapter.cancel("Cancelled before category selection. agentkit.yml not written.");
    return { cancelled: true };
  }

  const plan = await planImport({
    configPath: options.configPath,
    sourceDir: options.sourceDir,
    sources,
    categories,
    envPolicy: options.envPolicy ?? INTERACTIVE_ENV_POLICY
  });

  if (plan.candidates.length === 0) {
    adapter.message("No importable items discovered.");
    adapter.note(summarizeEnvActionItems(plan.envActionItems));
    adapter.finish("Nothing to import. agentkit.yml not written.");
    return { cancelled: false, plan };
  }

  const selection = await reviewSelection(adapter, plan);
  if (!selection) {
    adapter.cancel("Cancelled. agentkit.yml not written.");
    return { cancelled: true, plan };
  }

  const result = await applyImportPlan({
    plan,
    selection,
    dryRun: options.dryRun
  });

  if (result.aborted) {
    adapter.cancel("Aborted during apply. agentkit.yml not written.");
    return { cancelled: true, plan, result };
  }

  if (result.configWritten) {
    adapter.finish(`Wrote ${result.configPath}`);
  } else if (result.dryRun) {
    adapter.finish(`Dry run complete. Would update ${result.configPath}.`);
  } else if (!result.configChanged) {
    adapter.finish("Nothing changed. agentkit.yml not written.");
  } else {
    adapter.finish(`agentkit.yml not written (${result.conflicts.length} unresolved conflicts).`);
  }

  return { cancelled: false, plan, result };
}
