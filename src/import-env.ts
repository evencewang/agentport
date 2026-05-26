import type { McpServerConfig } from "./types.js";

export type EnvField =
  | { kind: "env"; key: string }
  | { kind: "header"; key: string };

export interface EnvActionItem {
  category: "mcp";
  itemName: string;
  field: EnvField;
  envVar: string;
  reason:
    | "preserved-placeholder"
    | "shell-var"
    | "env-http-headers"
    | "bearer-token"
    | "authorization-conflict"
    | "literal-secret"
    | "masked-secret";
  message: string;
}

export interface EnvPolicy {
  literals: "preserve" | "placeholder";
  masked: "preserve" | "placeholder";
}

export const NON_INTERACTIVE_ENV_POLICY: EnvPolicy = {
  literals: "preserve",
  masked: "preserve"
};

export const INTERACTIVE_ENV_POLICY: EnvPolicy = {
  literals: "placeholder",
  masked: "placeholder"
};

const ENV_PLACEHOLDER_REGEX = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/;
const SHELL_VAR_REGEX = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/;
const SAFE_ENV_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MASK_PATTERNS: RegExp[] = [
  /^[*\u2022\u00b7]{2,}$/,
  /^x{4,}$/i,
  /^<(redacted|hidden|secret|not-shown|set-in-env)>$/i,
  /^\[(redacted|hidden|secret|not-shown|set-in-env)\]$/i,
  /^\(set in [^)]+\)$/i,
  /^\.{3,}$/,
  /^---+$/
];

export function isEnvPlaceholder(value: string): string | undefined {
  const match = value.match(ENV_PLACEHOLDER_REGEX);
  return match ? match[1] : undefined;
}

export function isShellVarReference(value: string): string | undefined {
  const match = value.trim().match(SHELL_VAR_REGEX);
  return match ? match[1] : undefined;
}

export function looksMasked(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }

  return MASK_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function isValidEnvVarName(value: string): boolean {
  return SAFE_ENV_NAME_REGEX.test(value);
}

function sanitizeForEnvName(value: string): string {
  return value
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

export function deriveEnvVarName(itemName: string, fieldKey: string): string {
  const itemPart = sanitizeForEnvName(itemName);
  const fieldPart = sanitizeForEnvName(fieldKey);

  if (!itemPart && !fieldPart) {
    return "AGENTPORT_ENV";
  }
  if (!itemPart) {
    return fieldPart;
  }
  if (!fieldPart) {
    return itemPart;
  }
  if (fieldPart.startsWith(`${itemPart}_`) || fieldPart === itemPart) {
    return fieldPart;
  }

  return `${itemPart}_${fieldPart}`;
}

export function envPlaceholder(envVar: string): string {
  return `{env:${envVar}}`;
}

export interface RawEnvSourceMcp {
  env?: Record<string, string>;
  headers?: Record<string, string>;
  envHttpHeaders?: Record<string, string>;
  bearerTokenEnvVar?: string;
}

interface NormalizationContext {
  itemName: string;
  policy: EnvPolicy;
  actionItems: EnvActionItem[];
}

function applyValuePolicy(
  value: string,
  field: EnvField,
  context: NormalizationContext
): { value: string; envVar?: string; reason?: EnvActionItem["reason"] } {
  const trimmed = value.trim();

  const placeholderEnv = isEnvPlaceholder(trimmed);
  if (placeholderEnv) {
    return { value: trimmed, envVar: placeholderEnv, reason: "preserved-placeholder" };
  }

  const shellEnv = isShellVarReference(trimmed);
  if (shellEnv) {
    return { value: envPlaceholder(shellEnv), envVar: shellEnv, reason: "shell-var" };
  }

  if (looksMasked(trimmed)) {
    if (context.policy.masked === "placeholder") {
      const envVar = deriveEnvVarName(context.itemName, fieldEnvNameSegment(field));
      return { value: envPlaceholder(envVar), envVar, reason: "masked-secret" };
    }
    return { value };
  }

  if (!trimmed) {
    return { value };
  }

  // Field has a non-empty literal value that isn't a placeholder, shell var, or mask.
  if (context.policy.literals === "placeholder") {
    const envVar = deriveEnvVarName(context.itemName, fieldEnvNameSegment(field));
    return { value: envPlaceholder(envVar), envVar, reason: "literal-secret" };
  }

  return { value };
}

function fieldEnvNameSegment(field: EnvField): string {
  if (field.kind === "env") {
    return field.key;
  }

  if (field.key.toLowerCase() === "authorization") {
    return "TOKEN";
  }

  return field.key;
}

function fieldDescription(field: EnvField): string {
  return field.kind === "env" ? `env.${field.key}` : `headers.${field.key}`;
}

function pushEnvAction(
  context: NormalizationContext,
  field: EnvField,
  envVar: string,
  reason: EnvActionItem["reason"]
): void {
  const fieldDesc = fieldDescription(field);
  let message: string;
  switch (reason) {
    case "preserved-placeholder":
      message = `Set env var ${envVar} for MCP "${context.itemName}" ${fieldDesc} (existing {env:${envVar}} placeholder).`;
      break;
    case "shell-var":
      message = `Set env var ${envVar} for MCP "${context.itemName}" ${fieldDesc} (normalized from $${envVar}).`;
      break;
    case "literal-secret":
      message = `Set env var ${envVar} for MCP "${context.itemName}" ${fieldDesc} (proposed placeholder for literal value).`;
      break;
    case "masked-secret":
      message = `Set env var ${envVar} for MCP "${context.itemName}" ${fieldDesc} (masked source value not used as runtime config).`;
      break;
    case "env-http-headers":
      message = `Set env var ${envVar} for MCP "${context.itemName}" ${fieldDesc} (env_http_headers reference).`;
      break;
    case "bearer-token":
      message = `Set env var ${envVar} for MCP "${context.itemName}" ${fieldDesc} (bearer_token_env_var).`;
      break;
    case "authorization-conflict":
      message = `Review MCP "${context.itemName}" Authorization header: source declares bearer_token_env_var ${envVar} but explicit Authorization header exists; not overwritten.`;
      break;
  }

  context.actionItems.push({
    category: "mcp",
    itemName: context.itemName,
    field,
    envVar,
    reason,
    message
  });
}

export interface NormalizeMcpEnvResult {
  env?: Record<string, string>;
  headers?: Record<string, string>;
  actionItems: EnvActionItem[];
}

export function normalizeMcpEnvAndHeaders(
  itemName: string,
  raw: RawEnvSourceMcp,
  policy: EnvPolicy
): NormalizeMcpEnvResult {
  const context: NormalizationContext = { itemName, policy, actionItems: [] };

  const headers: Record<string, string> = {};
  if (raw.headers) {
    for (const [key, value] of Object.entries(raw.headers)) {
      const result = applyValuePolicy(value, { kind: "header", key }, context);
      headers[key] = result.value;
      if (result.envVar && result.reason) {
        pushEnvAction(context, { kind: "header", key }, result.envVar, result.reason);
      }
    }
  }

  if (raw.envHttpHeaders) {
    for (const [headerKey, envVarName] of Object.entries(raw.envHttpHeaders)) {
      const trimmed = envVarName.trim();
      if (!trimmed) {
        continue;
      }

      let envVar = trimmed;
      const placeholder = isEnvPlaceholder(trimmed);
      const shellVar = isShellVarReference(trimmed);
      if (placeholder) {
        envVar = placeholder;
      } else if (shellVar) {
        envVar = shellVar;
      } else if (!isValidEnvVarName(trimmed)) {
        envVar = deriveEnvVarName(itemName, headerKey);
      }

      headers[headerKey] = envPlaceholder(envVar);
      pushEnvAction(context, { kind: "header", key: headerKey }, envVar, "env-http-headers");
    }
  }

  if (raw.bearerTokenEnvVar) {
    const bearerEnvName = raw.bearerTokenEnvVar.trim();
    if (bearerEnvName) {
      let envVar = bearerEnvName;
      const placeholder = isEnvPlaceholder(bearerEnvName);
      const shellVar = isShellVarReference(bearerEnvName);
      if (placeholder) {
        envVar = placeholder;
      } else if (shellVar) {
        envVar = shellVar;
      } else if (!isValidEnvVarName(bearerEnvName)) {
        envVar = deriveEnvVarName(itemName, "TOKEN");
      }

      const existingAuth = Object.keys(headers).find(
        (key) => key.toLowerCase() === "authorization"
      );

      if (existingAuth) {
        pushEnvAction(
          context,
          { kind: "header", key: existingAuth },
          envVar,
          "authorization-conflict"
        );
      } else {
        headers.Authorization = `Bearer ${envPlaceholder(envVar)}`;
        pushEnvAction(
          context,
          { kind: "header", key: "Authorization" },
          envVar,
          "bearer-token"
        );
      }
    }
  }

  const env: Record<string, string> = {};
  if (raw.env) {
    for (const [key, value] of Object.entries(raw.env)) {
      const result = applyValuePolicy(value, { kind: "env", key }, context);
      env[key] = result.value;
      if (result.envVar && result.reason) {
        pushEnvAction(context, { kind: "env", key }, result.envVar, result.reason);
      }
    }
  }

  return {
    actionItems: context.actionItems,
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {})
  };
}

export function applyEnvPolicyToServer(
  server: McpServerConfig,
  policy: EnvPolicy
): { server: McpServerConfig; actionItems: EnvActionItem[] } {
  const result = normalizeMcpEnvAndHeaders(
    server.name,
    {
      env: server.env,
      headers: server.headers
    },
    policy
  );

  const next: McpServerConfig = {
    ...server,
    ...(result.env ? { env: result.env } : {}),
    ...(result.headers ? { headers: result.headers } : {})
  };

  if (!result.env) {
    delete next.env;
  }
  if (!result.headers) {
    delete next.headers;
  }

  return { server: next, actionItems: result.actionItems };
}

export function redactEnvValues(
  record: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!record) {
    return record;
  }

  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, redactValue(value)]));
}

export function redactValue(value: string): string {
  const trimmed = value.trim();
  const placeholder = isEnvPlaceholder(trimmed);
  if (placeholder) {
    return `{env:${placeholder}}`;
  }

  const shellVar = isShellVarReference(trimmed);
  if (shellVar) {
    return `\${${shellVar}}`;
  }

  if (!trimmed) {
    return "";
  }

  if (looksMasked(trimmed)) {
    return "<masked>";
  }

  return "<redacted>";
}
