---
name: aphrodite
description: Resolve imported local Figma links into bounded implementation context, preserve recorded measurements as facts, and implement verified flex/grid layouts with tracked application assets.
---

# Aphrodite

Use this skill when a task includes a copied Figma design link or a local `.fig` snapshot and the implementation agent needs offline design context.

## Prerequisites

- Aphrodite is built with Node.js 22+ (`npm run build`).
- The consuming project is initialized with `aphrodite init`.
- A local zipped `.fig` archive is available. Network access and Figma API tokens are not required. Raw `canvas.fig` and parser-shaped JSON are diagnostic/test inputs, not the primary handoff format.
- The first supported host is Codex. Install this self-contained directory by copying `skills/aphrodite/` into the user's Codex skills directory. Do not mutate a user profile from a project script.

## Import and query

```bash
node dist/cli.js init --project .
node dist/cli.js import ./design.fig --project . --file-key FILEKEY --alias handoff --json
node dist/cli.js inspect --project . --alias handoff --json
node dist/cli.js inspect --project . --url "https://www.figma.com/design/FILEKEY/Handoff?node-id=1-2" --json
```

The import step converts the `.fig` archive into the local `.aphrodite/.../document.json` representation and extracts cache-local assets. The file-only command lists visible top-level frames and sections. The node command returns bounded context. Use `--depth`, `--max-nodes`, and `--max-text-units` when a screen is large. Nested instance-path IDs return `INSTANCE_PATH_UNSUPPORTED`; do not guess an override mapping.

The equivalent MCP stdio configuration is:

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

Only `list_design_screens` and `get_design_context` are exposed. Keep the MCP process stdout untouched; diagnostics belong on stderr.

## Implementation loop

1. Inspect the existing project conventions, component system, typography, spacing tokens, and tracked asset directories before writing code.
2. Treat `facts` as recorded design evidence: geometry, layout properties, spacing, typography, visual styles, component references, and asset mappings. Treat `guidance` as confidence-labelled heuristics, not requirements.
3. Prefer semantic flexbox/grid and the project's existing primitives. Use absolute positioning only when the facts and the surrounding design justify it.
4. For an asset marked `resolved`, copy the selected cache file into an existing tracked application asset directory. Aphrodite never chooses or mutates that destination. Run `git check-ignore <destination>` and ensure it is not ignored before referencing the copy. Never import application code from `.aphrodite/`.
5. Validate geometry with the recorded bounds, responsive behavior, and the consuming project's tests or screenshot workflow. Screenshot capture/diffing remains the consuming agent's responsibility.

## Recovery

- `PROJECT_NOT_INITIALIZED`: run `init` from the intended project root.
- `DOCUMENT_NOT_IMPORTED`: import the snapshot with the same alias or file key used by the copied link.
- `NODE_NOT_FOUND`: verify the simple `session-local` node ID and that the selected snapshot contains it.
- `INSTANCE_PATH_UNSUPPORTED`: use the containing frame or a canonical simple node ID; do not infer a nested instance path.
- `UNSUPPORTED_FORMAT_VERSION`: this MVP accepts only canvas version 106. Keep the source and request an explicit format upgrade rather than bypassing the guard.
- `ASSET_NOT_FOUND`/unsupported asset records: use an existing tracked project asset or export the asset manually; do not make generated code depend on an ignored cache path.
- Cache/schema/lock errors: stop the MCP process, verify the project root, and remove only that root's disposable `.aphrodite/` directory before re-running `init` and `import`.
