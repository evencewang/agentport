import test from "node:test";
import assert from "node:assert/strict";

import {
  applyEnvPolicyToServer,
  deriveEnvVarName,
  INTERACTIVE_ENV_POLICY,
  isEnvPlaceholder,
  isShellVarReference,
  looksMasked,
  NON_INTERACTIVE_ENV_POLICY,
  normalizeMcpEnvAndHeaders,
  redactValue
} from "../import-env.js";

test("isEnvPlaceholder recognizes {env:NAME} only", () => {
  assert.equal(isEnvPlaceholder("{env:CONTEXT7_API_KEY}"), "CONTEXT7_API_KEY");
  assert.equal(isEnvPlaceholder("{env:_NAME1}"), "_NAME1");
  assert.equal(isEnvPlaceholder("Bearer {env:TOKEN}"), undefined);
  assert.equal(isEnvPlaceholder("$NAME"), undefined);
  assert.equal(isEnvPlaceholder("plain-string"), undefined);
});

test("isShellVarReference handles $NAME and ${NAME}", () => {
  assert.equal(isShellVarReference("$TOKEN"), "TOKEN");
  assert.equal(isShellVarReference("${TOKEN}"), "TOKEN");
  assert.equal(isShellVarReference(" $TOKEN "), "TOKEN");
  assert.equal(isShellVarReference("plain"), undefined);
});

test("looksMasked detects common mask patterns", () => {
  assert.equal(looksMasked("***"), true);
  assert.equal(looksMasked("xxxxxxx"), true);
  assert.equal(looksMasked("<redacted>"), true);
  assert.equal(looksMasked("[hidden]"), true);
  assert.equal(looksMasked("(set in env)"), true);
  assert.equal(looksMasked("ghp_AAAA1234"), false);
});

test("deriveEnvVarName combines item and field segments uppercased", () => {
  assert.equal(deriveEnvVarName("context7", "Authorization"), "CONTEXT7_AUTHORIZATION");
  assert.equal(deriveEnvVarName("context7", "CONTEXT7_API_KEY"), "CONTEXT7_API_KEY");
  assert.equal(deriveEnvVarName("my-tool", "x-api-key"), "MY_TOOL_X_API_KEY");
});

test("non-interactive policy preserves existing env placeholder, normalizes shell var, preserves literal", () => {
  const result = normalizeMcpEnvAndHeaders(
    "context7",
    {
      env: {
        ALREADY_PLACEHOLDER: "{env:KEEP_ME}",
        SHELLED: "$EXISTING_NAME",
        BRACED: "${BRACED_NAME}",
        LITERAL: "actual-secret"
      }
    },
    NON_INTERACTIVE_ENV_POLICY
  );

  assert.deepEqual(result.env, {
    ALREADY_PLACEHOLDER: "{env:KEEP_ME}",
    SHELLED: "{env:EXISTING_NAME}",
    BRACED: "{env:BRACED_NAME}",
    LITERAL: "actual-secret"
  });
  const reasons = result.actionItems.map((item) => item.reason).sort();
  assert.deepEqual(reasons, ["preserved-placeholder", "shell-var", "shell-var"]);
  const preserved = result.actionItems.find((item) => item.reason === "preserved-placeholder");
  assert.equal(preserved?.envVar, "KEEP_ME");
  assert.match(preserved?.message ?? "", /Set env var KEEP_ME/);
  for (const item of result.actionItems) {
    assert.doesNotMatch(item.message, /actual-secret/);
  }
});

test("interactive policy converts literal and masked values to placeholders without leaking values", () => {
  const result = normalizeMcpEnvAndHeaders(
    "context7",
    {
      env: { API_KEY: "shhh-this-is-a-real-token" },
      headers: { Authorization: "Bearer abcdef-12345", "X-Status": "***" }
    },
    INTERACTIVE_ENV_POLICY
  );

  assert.equal(result.env?.API_KEY, "{env:CONTEXT7_API_KEY}");
  assert.equal(result.headers?.Authorization, "{env:CONTEXT7_TOKEN}");
  assert.equal(result.headers?.["X-Status"], "{env:CONTEXT7_X_STATUS}");
  for (const item of result.actionItems) {
    assert.doesNotMatch(item.message, /abcdef-12345|shhh-this-is-a-real-token/);
  }
  assert.ok(result.actionItems.some((item) => item.reason === "literal-secret"));
  assert.ok(result.actionItems.some((item) => item.reason === "masked-secret"));
});

test("env_http_headers normalize to {env:ENV_NAME} headers regardless of policy", () => {
  const nonInteractive = normalizeMcpEnvAndHeaders(
    "codex",
    { envHttpHeaders: { "X-Api-Key": "CODEX_API_KEY" } },
    NON_INTERACTIVE_ENV_POLICY
  );
  assert.equal(nonInteractive.headers?.["X-Api-Key"], "{env:CODEX_API_KEY}");
  assert.ok(
    nonInteractive.actionItems.some(
      (item) => item.envVar === "CODEX_API_KEY" && item.reason === "env-http-headers"
    )
  );

  const interactive = normalizeMcpEnvAndHeaders(
    "codex",
    { envHttpHeaders: { "X-Api-Key": "CODEX_API_KEY" } },
    INTERACTIVE_ENV_POLICY
  );
  assert.equal(interactive.headers?.["X-Api-Key"], "{env:CODEX_API_KEY}");
});

test("bearer_token_env_var becomes Authorization Bearer placeholder when no header exists", () => {
  const result = normalizeMcpEnvAndHeaders(
    "codex",
    { bearerTokenEnvVar: "CODEX_BEARER" },
    NON_INTERACTIVE_ENV_POLICY
  );
  assert.equal(result.headers?.Authorization, "Bearer {env:CODEX_BEARER}");
  assert.ok(
    result.actionItems.some(
      (item) => item.reason === "bearer-token" && item.envVar === "CODEX_BEARER"
    )
  );
});

test("bearer_token_env_var conflicts with explicit Authorization header without overwriting", () => {
  const result = normalizeMcpEnvAndHeaders(
    "codex",
    {
      headers: { Authorization: "Bearer codex" },
      bearerTokenEnvVar: "CODEX_BEARER"
    },
    NON_INTERACTIVE_ENV_POLICY
  );
  assert.equal(result.headers?.Authorization, "Bearer codex");
  const conflict = result.actionItems.find((item) => item.reason === "authorization-conflict");
  assert.ok(conflict);
  assert.equal(conflict?.envVar, "CODEX_BEARER");
  for (const item of result.actionItems) {
    assert.doesNotMatch(item.message, /Bearer codex/);
  }
});

test("redactValue keeps placeholders and shell vars but masks anything else", () => {
  assert.equal(redactValue("{env:NAME}"), "{env:NAME}");
  assert.equal(redactValue("$ENV"), "${ENV}");
  assert.equal(redactValue("plain-secret"), "<redacted>");
  assert.equal(redactValue("***"), "<masked>");
  assert.equal(redactValue(""), "");
});

test("applyEnvPolicyToServer keeps placeholders intact and lists them as action items", () => {
  const { server, actionItems } = applyEnvPolicyToServer(
    {
      name: "context7",
      transport: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "{env:CONTEXT7_TOKEN}" }
    },
    INTERACTIVE_ENV_POLICY
  );

  assert.equal(server.headers?.Authorization, "{env:CONTEXT7_TOKEN}");
  assert.equal(actionItems.length, 1);
  assert.equal(actionItems[0]?.reason, "preserved-placeholder");
  assert.equal(actionItems[0]?.envVar, "CONTEXT7_TOKEN");
});
