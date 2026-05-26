# agentport

`agentport` is a small CLI for one job: keep one source of truth for your AI coding setup, then render compatible files for different tools.

Current MVP targets:

- `claude`
- `codex`
- `cursor`
- `opencode`

Current MVP surfaces:

- shared instructions
- Cursor rules
- commands
- skills
- MCP servers

## Why this exists

The portable parts of the modern agent stack are emerging unevenly:

- `MCP` is fairly portable.
- `SKILL.md` is increasingly portable.
- instructions, commands, and agent-specific config files are still fragmented.

`agentport` treats that as a compiler problem:

1. Write a neutral config once.
2. Render target-specific files.
3. Review the generated output before installing or symlinking it.

## Install

```bash
npm install
npm run build
```

## Quick start

Create a starter config:

```bash
node dist/cli.js init
```

Build generated files:

```bash
node dist/cli.js build
```

Build to a custom directory:

```bash
node dist/cli.js build --out .generated
```

Build only selected targets:

```bash
node dist/cli.js build --target claude,cursor
node dist/cli.js build --target claude --target opencode
```

Build every supported target, ignoring any selected profile target defaults:

```bash
node dist/cli.js build --all-targets
```

Preview before writing files:

```bash
node dist/cli.js build --dry-run
node dist/cli.js build --stdout
```

Use a named profile from `agentkit.yml`:

```bash
node dist/cli.js build --profile universal-core
node dist/cli.js build --profile universal-core --target claude --dry-run
```

Profile target precedence is deterministic: explicit CLI targets or `--all-targets` win,
then profile `targets`, then the default set of all supported targets.

## Example config

See [examples/basic.agentkit.yml](examples/basic.agentkit.yml).

Default config path:

```text
agentkit.yml
```

Profiles select reusable subsets by existing item names:

```yaml
profiles:
  - name: universal-core
    targets: [claude, cursor, opencode]
    mcpServers: [context7]
    commands: [review-changes]
    skills: [write-release-notes]
    rules: [frontend]

  - name: docs-only
    targets: [claude, codex]
    commands: []      # explicit empty selection means no commands
    mcpServers: []    # omitted categories keep base behavior
```

Per-item `targets` filters still apply after profile selection, so a selected item can
remain target-specific.

Profiles do not select instructions in this MVP. Shared and target-specific
instructions are not named selectable items yet, so they remain part of the base
config for any selected profile.

## Import existing tool config

Preview imports before changing `agentkit.yml`:

```bash
node dist/cli.js import --from claude --include all --dry-run
node dist/cli.js import --from claude,cursor --include mcp,commands --dry-run
node dist/cli.js import --from opencode --from codex --include mcp --include skills
```

`--from` and `--include` are explicit and required. Both flags support repeated
values and comma-separated values. By default, import scans the current directory
and writes `agentkit.yml`; use `--source-dir <dir>` and `--config <path>` to
override those paths.

Supported local import conventions:

| Source | MCP | Commands | Skills |
| --- | --- | --- | --- |
| `claude` | `.mcp.json` | `.claude/commands/*.md` | `.claude/skills/*/SKILL.md` |
| `cursor` | `.cursor/mcp.json` | `.cursor/commands/*.md` | unsupported |
| `opencode` | `opencode.json` | `.opencode/commands/*.md` | `.opencode/skills/*/SKILL.md` |
| `codex` | `.codex/config.toml` `[mcp_servers.<name>]` | unsupported | `.codex/skills/*/SKILL.md` |

Unsupported source/category combinations are reported as skipped, not fatal.
Equivalent duplicates are reported as unchanged. Conflicting duplicates with the
same category and name abort without writing.

MCP imports use runtime-aware duplicate handling instead of full YAML/JSON object
equality. For HTTP and SSE MCP servers, agentport compares transport plus a
narrowly normalized endpoint; protocol and host casing are normalized, and an
obvious trailing slash is ignored only when no query string is present. Path and
query semantics are otherwise preserved. For stdio MCP servers, agentport
compares transport, command, and ordered args. MCP `env` and `headers` are
compared by key shape only, and import diagnostics do not print secret values.

When an imported MCP has the same name and runtime identity as an existing MCP,
agentport keeps the existing runtime values as canonical. If the import includes
additional explicit `targets`, they are merged without duplicates; otherwise the
server is reported as unchanged. Same-name MCPs with different runtime identity
or secret key shape remain blocking conflicts.

Different-name MCPs that share the same runtime identity are reported as
non-blocking possible duplicates. agentport still writes non-conflicting imports,
but it does not automatically merge, rename, or interactively resolve possible
duplicates.

MCP `env`, `headers`, Codex `http_headers`, `env_http_headers`, and bearer-token
env-var fields are preserved where the universal config can represent them, but
they trigger warnings so you can review secrets before committing generated YAML.

## Output model

`agentport` writes target-specific files into a generated directory, for example:

```text
.generated/
  claude/
    CLAUDE.md
    .claude/commands/
    .claude/skills/
    .mcp.json
  cursor/
    AGENTS.md
    .cursor/rules/
    .cursor/commands/
    .cursor/mcp.json
  codex/
    AGENTS.md
    .codex/skills/
  opencode/
    AGENTS.md
    .opencode/commands/
    .opencode/skills/
    opencode.json
```

This is intentionally review-first. An `apply` or `sync` command can come later.

## Current support notes

- `claude`: strongest support in this MVP.
- `cursor`: instructions, rules, commands, and MCP are supported. Skill generation is omitted until Cursor skills are documented more clearly in official docs.
- `opencode`: instructions, commands, skills, and MCP are supported.
- `codex` build/render output: instructions and skills are generated. Commands and MCP are still emitted as warnings because stable local Codex output conventions vary across hosts.
- `codex` import: MCP from `.codex/config.toml` and skills from `.codex/skills/*/SKILL.md` are supported; commands are unsupported and reported as skipped.

## Roadmap

- expand import coverage beyond local project config conventions
- `apply` mode to write directly into a repo or home config
- schema validation with richer diagnostics
- diff mode
- hook and agent adapters
- symlink mode for shared local setups

Deferred from the core profile workflow: full-screen TUI, source-tool importers,
remote imports, registries/marketplace, plugins, profile inheritance, and live
preview panes.

Deferred from config import: instructions/rules import, home-directory auto-scan,
remote imports, registries/marketplace, profile auto-generation, full TUI, and
apply/sync back into tool folders.
