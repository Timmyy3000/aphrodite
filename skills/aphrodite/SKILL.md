---
name: aphrodite
description: Use Aphrodite's local MCP server to turn a local Figma .fig file and a copied frame link into bounded, structured design context for pixel-accurate UI implementation. Trigger when an agent needs to implement, inspect, or troubleshoot a Figma frame offline, especially when the result should use semantic flexbox/grid instead of brittle absolute positioning.
---

# Aphrodite

Aphrodite is an MCP-first design implementation tool. It gives an agent local, structured evidence from a `.fig` file—hierarchy, measurements, typography, visual styles, components, layout facts, and asset references—plus confidence-labelled flex/grid guidance. Use that context to get the rendered result close to the design without treating Figma coordinates as a mandate for absolute positioning.

## Operating rule

Use the Aphrodite MCP tools as the design-context interface. Use the CLI only to initialize a consuming project, import the local `.fig`, and diagnose setup or import errors. Do not parse `.aphrodite` internals or parser JSON yourself when MCP is available.

## Get the user running

Walk the user through this sequence when Aphrodite is not connected:

1. Confirm that Node.js 22+ is installed and identify the application project root.
2. Ask for the path to the local zipped `.fig` file. Do not ask for a Figma API token; Aphrodite is local-only.
3. Ask whether the user will paste a Figma frame link. If so, import with the link's file key; otherwise use a stable alias.
4. Run the GitHub-backed npx commands from the application project root. This does not require an npm publication or a repository checkout in the application:

   ```bash
   npx --yes github:Timmyy3000/aphrodite#v0.2.0 init --project .
   npx --yes github:Timmyy3000/aphrodite#v0.2.0 import /path/to/design.fig --project . --file-key FILEKEY --alias handoff --json
   ```

   Use a quoted path on Windows PowerShell:

   ```powershell
   npx --yes github:Timmyy3000/aphrodite#v0.2.0 init --project .
   npx --yes github:Timmyy3000/aphrodite#v0.2.0 import ".\design.fig" --project . --file-key FILEKEY --alias handoff --json
   ```

   The first npx run downloads the public GitHub package into npm's cache and builds the CLI through its `prepare` script. If the user wants a fixed/offline checkout, clone the repository, run `npm ci` and `npm run build`, and replace the npx command with `node /absolute/path/to/aphrodite/dist/cli.js`.

5. Add the MCP server to the user's agent host and reload it:

   ```json
   {
     "mcpServers": {
       "aphrodite": {
         "command": "npx",
         "args": [
           "--yes",
           "github:Timmyy3000/aphrodite#v0.2.0",
           "mcp",
           "--project",
           "/absolute/path/to/the/application"
         ]
       }
     }
   }
   ```

   For a persistent checkout, set `command` to `node` and the first argument to that checkout's `dist/cli.js`.

Explain that installing this skill and connecting the MCP server are separate steps: the skill is the agent's playbook, while MCP provides live design data.

## MCP-first implementation loop

When the user gives a copied frame link or asks to implement a screen:

1. Confirm the application root, imported alias/file key, and requested frame link or node ID. Ask only for missing prerequisites.
2. Call `list_design_screens` with `{ "fileKey": "FILEKEY" }` or `{ "alias": "handoff" }` to verify the import and discover visible screens.
3. Call `get_design_context` for the requested frame. Prefer the copied URL when the import was registered with its file key:

   ```json
   { "url": "https://www.figma.com/design/FILEKEY/Handoff?node-id=1-2" }
   ```

   Otherwise use `{ "alias": "handoff", "nodeId": "1:2" }`. Request smaller `depth`, `maxNodes`, or `maxTextUnits` budgets when a frame is large.
4. Read `facts` as recorded design evidence: bounds, layout mode, padding, gaps, sizing, typography, fills, strokes, radii, component references, and asset mappings.
5. Read `guidance` as heuristics. Preserve its confidence and evidence; do not present a suggestion as a Figma fact.
6. Inspect the consuming project's existing components, tokens, typography, responsive conventions, and tracked asset directories before writing code.
7. Build semantic flexbox/grid structure that reproduces the recorded relationships. Use absolute positioning only when the evidence and surrounding design genuinely require it; do not translate every `x`/`y` coordinate into CSS.
8. For an asset marked `resolved`, copy the cache file into an existing tracked application asset directory. Verify the destination with `git check-ignore <destination>` and make sure it is not ignored. Never make application code depend on `.aphrodite/`.
9. Validate the implementation with the consuming project's tests, responsive checks, and rendered output. Do not use browser screenshots as a substitute for design evidence missing from Aphrodite; report the extraction gap so the local handoff can be improved.

## Tool contract

Aphrodite exposes exactly two MCP tools:

- `list_design_screens`: list visible top-level frame/section screens for a file key, alias, or URL.
- `get_design_context`: return bounded context for a node, including facts, children, assets, guidance, warnings, and truncation information.

MCP stdout is reserved for JSON-RPC; diagnostics belong on stderr. Responses are bounded. Treat `truncation` as part of the result: if content was omitted, request a narrower subtree or a larger permitted budget rather than inventing missing details.

Version `0.2.0` returns parser-native sizes and positions, compact paints, stack layout fields, and font/rich-text styles. Its default query includes two descendant levels to preserve semantic structure without flooding context with deep vector internals.

## Recovery

- `PROJECT_NOT_INITIALIZED`: run `init` from the intended application root.
- `DOCUMENT_NOT_IMPORTED`: import the `.fig` with the same alias or file key used by the query.
- `NODE_NOT_FOUND`: verify the simple `pageId:nodeId` from the copied link and the selected import.
- `INSTANCE_PATH_UNSUPPORTED`: use the containing frame or a canonical simple node ID; do not infer an override mapping.
- `UNSUPPORTED_FORMAT_VERSION`: this MVP accepts canvas version 106. Keep the source and request an explicit parser upgrade rather than bypassing the guard.
- `ASSET_NOT_FOUND` or an unsupported asset record: use a tracked project asset or export the asset manually; do not generate code that depends on a missing cache file.
- Cache, schema, or lock errors: stop the MCP process, verify the application root, and remove only that root's disposable `.aphrodite/` directory before re-running `init` and `import`.
