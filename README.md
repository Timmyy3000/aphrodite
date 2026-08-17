# Aphrodite

Aphrodite is an MCP-first, local-first Figma `.fig` tool for agents building pixel-perfect interfaces. It turns a local design file and a copied frame link into bounded, structured design context: recorded measurements and styles, hierarchy, component information, asset references, and confidence-labelled flex/grid guidance. The goal is a close computed result without forcing agents into brittle absolute positioning. Figma API access and an npm publication are not required.

## Start with MCP (no repository checkout required)

Users only need Node.js 22+ (which includes `npm`/`npx`), a local zipped `.fig` file, and an application project root. The GitHub package is built on first use and cached by npm; it is not downloaded from or published to the npm registry.

From the application project root, run:

```bash
npx --yes github:Timmyy3000/aphrodite init --project .
npx --yes github:Timmyy3000/aphrodite import /path/to/design.fig --project . --file-key FILEKEY --alias handoff --json
```

On Windows PowerShell, quote paths that contain spaces:

```powershell
npx --yes github:Timmyy3000/aphrodite init --project .
npx --yes github:Timmyy3000/aphrodite import ".\design.fig" --project . --file-key FILEKEY --alias handoff --json
```

Use `--file-key` when the agent will receive a copied Figma URL; use only `--alias handoff` when the agent will refer to the imported file by alias.

Then add Aphrodite to the agent host's MCP configuration. The portable GitHub/npx form is:

```json
{
  "mcpServers": {
    "aphrodite": {
      "command": "npx",
      "args": [
        "--yes",
        "github:Timmyy3000/aphrodite",
        "mcp",
        "--project",
        "/absolute/path/to/the/application"
      ]
    }
  }
}
```

Restart or reload the agent host after saving the entry. The agent can now call `list_design_screens` and `get_design_context` over MCP. Give it a copied Figma frame link and ask it to implement the frame; it should resolve the link through the local import, inspect the structured context, and build with the consuming project's flex/grid primitives.

### Persistent/offline installation

For teams that prefer a fixed local checkout instead of an npx-managed cache:

```bash
git clone --depth 1 https://github.com/Timmyy3000/aphrodite.git
cd aphrodite
npm ci
npm run build
node dist/cli.js init --project /path/to/the/application
node dist/cli.js import /path/to/design.fig --project /path/to/the/application --alias handoff --json
```

Use this MCP entry for that checkout:

```json
{
  "mcpServers": {
    "aphrodite": {
      "command": "node",
      "args": [
        "/absolute/path/to/aphrodite/dist/cli.js",
        "mcp",
        "--project",
        "/absolute/path/to/the/application"
      ]
    }
  }
}
```

The `prepare` script also builds the CLI when npm installs the GitHub package, so the npx path works even though `dist/` is not committed.

## The MCP-first agent workflow

When a user asks to implement a design, the agent should:

1. Ask for any missing pieces: the application project root, the local `.fig` path, and the copied frame link (or a frame ID).
2. Help the user run the two npx setup/import commands if the project has not been initialized.
3. Call `list_design_screens` to confirm the imported file, then `get_design_context` for the requested frame.
4. Treat `facts` as recorded design evidence and `guidance` as confidence-labelled implementation suggestions.
5. Inspect the consuming project's components, tokens, typography, and asset conventions before writing code.
6. Implement semantic flexbox/grid structure, copy only selected resolved assets into tracked application directories, and validate the result with the project's screenshot or test workflow.

The CLI remains available for initialization, import, and diagnostics; MCP is the primary design-context interface for agents.

## URLs and context

Simple copied links such as `https://www.figma.com/design/FILEKEY/name?node-id=1-2` resolve offline after importing with the matching `--file-key`. File-only queries list visible top-level frame/section screens. Node queries return bounded geometry, layout, visual, text, component, and asset facts. Nested instance-path IDs are intentionally rejected with `INSTANCE_PATH_UNSUPPORTED` until a deterministic mapping is available.

CLI errors with `--json` use the same versioned `{ schemaVersion: 1, error: ... }` envelope returned by MCP. Use `--depth`, `--max-nodes`, and `--max-text-units` to request smaller context; hard-limit violations are explicit errors rather than silent clamping.

## Assets and application ownership

Extracted assets are cache-local references under `.aphrodite/documents/<import-id>/assets/` and are gitignored. When implementing an application, copy only the selected asset into an existing tracked application asset directory, verify the destination with `git check-ignore`, and reference the tracked copy. Aphrodite does not choose or mutate that directory, so generated application code never depends on ignored cache paths.

## Skill

The repository-owned Codex skill is at [`skills/aphrodite/SKILL.md`](skills/aphrodite/SKILL.md). The skill teaches an agent the MCP-first workflow, how to walk a user through setup, and how to turn a frame into a pixel-accurate flex/grid implementation.

To install it for Codex, clone or download this repository and copy the complete `skills/aphrodite/` directory into the host's skills directory. For example, on Windows PowerShell:

```powershell
git clone --depth 1 https://github.com/Timmyy3000/aphrodite.git
Copy-Item -Recurse -Force .\aphrodite\skills\aphrodite "$env:USERPROFILE\.codex\skills\aphrodite"
```

On macOS/Linux:

```bash
git clone --depth 1 https://github.com/Timmyy3000/aphrodite.git
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
cp -R aphrodite/skills/aphrodite "${CODEX_HOME:-$HOME/.codex}/skills/aphrodite"
```

Installing the skill and running the MCP server are separate: the skill gives the agent the playbook, while the MCP entry above gives it live local design context. An agent can also use this README and the public repository URL to guide a user through the npx setup without having the repository checked out in the application project.

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
