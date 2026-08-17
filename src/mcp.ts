import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { DesignStore } from './context/extract.js';
import { asAphroditeError } from './core/errors.js';
import { GetDesignContextInputV1, ListScreensInputV1, type GetDesignContextInputV1 as GetDesignContextInput } from './contracts/v1.js';

function success(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value } as any;
}

function failure(error: unknown) {
  const normalized = asAphroditeError(error);
  const envelope = normalized.envelope();
  return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(envelope) }], structuredContent: envelope } as any;
}

function contextArgs(parsed: GetDesignContextInput) {
  if ('ref' in parsed) return { ref: parsed.ref, budget: { ...(parsed.depth === undefined ? {} : { depth: parsed.depth }), ...(parsed.maxNodes === undefined ? {} : { maxNodes: parsed.maxNodes }), ...(parsed.maxTextUnits === undefined ? {} : { maxTextUnits: parsed.maxTextUnits }) } };
  const { depth, maxNodes, maxTextUnits, ...ref } = parsed;
  return { ref, budget: { ...(depth === undefined ? {} : { depth }), ...(maxNodes === undefined ? {} : { maxNodes }), ...(maxTextUnits === undefined ? {} : { maxTextUnits }) } };
}

/** Build a server with exactly the two planned tools, without touching stdout. */
export function createMcpServer(projectRoot = process.cwd()): McpServer {
  const store = new DesignStore(projectRoot);
  const server = new McpServer({ name: 'aphrodite', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.registerTool('list_design_screens', { title: 'List design screens', description: 'List visible top-level screens from an imported local Figma document.', inputSchema: ListScreensInputV1 }, async raw => {
    try { return success(await store.listScreens(raw)); } catch (error) { return failure(error); }
  });
  server.registerTool('get_design_context', { title: 'Get design context', description: 'Resolve a local Figma node and return bounded implementation-oriented facts.', inputSchema: GetDesignContextInputV1 }, async raw => {
    try { const args = contextArgs(raw); return success(await store.getNodeContext(args.ref, args.budget)); } catch (error) { return failure(error); }
  });
  return server;
}

export async function startMcpServer(projectRoot = process.cwd()): Promise<StdioServerHandle> {
  const handle = serveStdio(() => createMcpServer(projectRoot), { onerror: error => process.stderr.write(`[aphrodite:mcp] ${error.message}\n`) });
  return handle;
}
