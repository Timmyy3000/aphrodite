# Aphrodite

A local-first Figma `.fig` importer for implementation agents. Aphrodite parses a local `.fig` archive, publishes its parser-shaped JSON representation, indexes it, and extracts usable assets under the disposable `.aphrodite/` cache. Canvas version 106 is the supported MVP boundary.

## Quick start

```bash
npm ci
npm run build
node dist/cli.js init --project .
node dist/cli.js import E:/path/to/design.fig --project . --file-key FILEKEY --alias handoff --json
node dist/cli.js inspect --project . --alias handoff --json
node dist/cli.js inspect --project . --url "https://www.figma.com/design/FILEKEY/Handoff?node-id=1-2" --json
```

The primary import is a local zipped `.fig` file. Import writes the decoded parser-shaped representation to `.aphrodite/documents/<import-id>/document.json`; raw `canvas.fig` and parser-shaped JSON remain available only as diagnostic/test inputs. File-key registration is also supported with `--file-key`. Imports never initialize a project implicitly and never write into an application asset directory.

## MCP

Run the stdio server from an initialized project:

```bash
node dist/cli.js mcp --project /path/to/project
```

The server exposes exactly `list_design_screens` and `get_design_context`. Configure a Codex MCP entry with the emitted command, for example:

```json
{
  "mcpServers": {
    "aphrodite": {
      "command": "node",
      "args": ["/absolute/path/to/aphrodite/dist/cli.js", "mcp", "--project", "/absolute/path/to/project"]
    }
  }
}
```

MCP stdout is reserved for JSON-RPC. Diagnostics are written to stderr. Responses are bounded and keep recorded design facts separate from confidence-labelled flex/grid guidance.

## URLs and context

Simple copied links such as `https://www.figma.com/design/FILEKEY/name?node-id=1-2` resolve offline after importing with the matching `--file-key`. File-only queries list visible top-level frame/section screens. Node queries return bounded geometry, layout, visual, text, component, and asset facts. Nested instance-path IDs are intentionally rejected with `INSTANCE_PATH_UNSUPPORTED` until a deterministic mapping is available.

CLI errors with `--json` use the same versioned `{ schemaVersion: 1, error: ... }` envelope returned by MCP. Use `--depth`, `--max-nodes`, and `--max-text-units` to request smaller context; hard-limit violations are explicit errors rather than silent clamping.

## Assets and application ownership

Extracted assets are cache-local references under `.aphrodite/documents/<import-id>/assets/` and are gitignored. When implementing an application, copy only the selected asset into an existing tracked application asset directory, verify the destination with `git check-ignore`, and reference the tracked copy. Aphrodite does not choose or mutate that directory, so generated application code never depends on ignored cache paths.

## Skill

The repository-owned Codex skill is at `skills/aphrodite/SKILL.md`. Install it by copying the complete `skills/aphrodite/` directory into the user's Codex skills directory; the MVP deliberately does not mutate a real profile or provide an installer for other agent hosts.

## Validation

```bash
npm run fixtures:verify
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run test:performance
npm run skill:smoke
```

The mandatory performance fixture is checked in and contains more than 5,000 representative nodes. A private external `.fig` can be exercised explicitly without copying it into this repository:

```bash
npm run test:performance:external -- --fixture <path-to-private-design.fig>
```

The external file is supplied by the local user and is never bundled or committed.
