import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCli } from '../../src/cli.js';
import { parseFigmaFileRef, parseFigmaNodeRef } from '../../src/context/figma-url.js';
import { DesignContextV1, ScreenListV1 } from '../../src/contracts/v1.js';

const fixture = join(process.cwd(), 'tests', 'fixtures', 'generated', 'correctness-v106.json');
function capture() { const stdout: string[] = []; const stderr: string[] = []; return { io: { stdout: { write: (value: string) => { stdout.push(value); return true; } } as any, stderr: { write: (value: string) => { stderr.push(value); return true; } } as any }, stdout, stderr }; }

describe('surface e2e', () => {
  it('initializes, imports, lists screens, and resolves a node from a copied URL', async () => {
    const project = await mkdtemp(join(tmpdir(), 'aphrodite-e2e-'));
    let c = capture(); expect(await runCli(['init', '--project', project, '--json'], c.io)).toBe(0);
    c = capture(); expect(await runCli(['import', fixture, '--project', project, '--file-key', 'FILE123', '--alias', 'fixture', '--json'], c.io)).toBe(0);
    c = capture(); expect(await runCli(['inspect', '--project', project, '--url', 'https://www.figma.com/design/FILE123/Handoff?node-id=1-2', '--json'], c.io)).toBe(0);
    const output = JSON.parse(c.stdout.join('').trim());
    expect(ScreenListV1.safeParse(output).success).toBe(false);
    expect(DesignContextV1.parse(output).target.id).toBe('1:2');
    expect(parseFigmaFileRef({ url: 'https://figma.com/file/FILE123/Handoff' })).toEqual({ fileKey: 'FILE123' });
    expect(parseFigmaNodeRef({ url: 'https://figma.com/design/FILE123/Handoff?node-id=1-2' })).toEqual({ fileKey: 'FILE123', nodeId: '1:2' });
  });

  it('returns explicit nested instance-path errors', async () => {
    const project = await mkdtemp(join(tmpdir(), 'aphrodite-e2e-'));
    let c = capture(); await runCli(['init', '--project', project], c.io);
    c = capture(); const code = await runCli(['inspect', '--project', project, '--url', 'https://figma.com/design/FILE123/Handoff?node-id=1-2;I3-4', '--json'], c.io);
    expect(code).toBe(2); expect(JSON.parse(c.stdout.join('')).error.code).toBe('INSTANCE_PATH_UNSUPPORTED');
  });

  it('keeps stdio MCP transport clean and advertises the planned tools', async () => {
    const project = await mkdtemp(join(tmpdir(), 'aphrodite-mcp-'));
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'mcp', '--project', project], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let buffer = '';
    const lines: string[] = [];
    child.stdout.on('data', chunk => { buffer += String(chunk); const parts = buffer.split('\n'); buffer = parts.pop() ?? ''; lines.push(...parts.filter(Boolean)); });
    const waitFor = async (id: number) => { for (let attempt = 0; attempt < 40; attempt++) { const line = lines.find(value => value.includes(`\"id\":${id}`)); if (line) return JSON.parse(line); await new Promise(resolve => setTimeout(resolve, 25)); } throw new Error(`MCP response ${id} timed out`); };
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } })}\n`);
    await waitFor(1);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
    const response = await waitFor(2);
    expect(response.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['list_design_screens', 'get_design_context']);
    expect(lines.every(line => !line.includes('[aphrodite:mcp]'))).toBe(true);
    child.kill();
  });

});
