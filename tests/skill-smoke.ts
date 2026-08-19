import { cp, mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCli } from '../src/cli.js';

const execFile = promisify(execFileCallback);

const root = await mkdtemp(join(tmpdir(), 'aphrodite-skill-'));
const skillsRoot = join(root, 'skills');
const copied = join(skillsRoot, 'aphrodite');
await cp(join(process.cwd(), 'skills', 'aphrodite'), copied, { recursive: true });
const skill = (await readFile(join(copied, 'SKILL.md'), 'utf8')).replace(/\r\n/g, '\n');
if (!skill.startsWith('---\nname: aphrodite\ndescription: ')) throw new Error('Skill frontmatter is missing the required name/description.');
if (!skill.includes('MCP-first') || !skill.includes('npx --yes github:Timmyy3000/aphrodite')) throw new Error('Skill is missing the MCP-first GitHub setup workflow.');
const interfaceMetadata = await readFile(join(copied, 'agents', 'openai.yaml'), 'utf8');
if (!interfaceMetadata.includes('display_name:') || !interfaceMetadata.includes('default_prompt:')) throw new Error('Skill UI metadata is missing required interface fields.');
if (!(await stat(join(copied, 'SKILL.md'))).isFile()) throw new Error('Copied skill is not discoverable.');
if (!(await readdir(skillsRoot)).includes('aphrodite')) throw new Error('Copied skill directory was not discovered.');

const project = join(root, 'project');
const fixture = join(process.cwd(), 'tests', 'fixtures', 'generated', 'correctness-v106.json');
const capture = () => { const stdout: string[] = []; const stderr: string[] = []; return { io: { stdout: { write: (value: string) => { stdout.push(value); return true; } } as any, stderr: { write: (value: string) => { stderr.push(value); return true; } } as any }, stdout, stderr }; };
let c = capture(); if (await runCli(['init', '--project', project], c.io) !== 0) throw new Error('Skill init example failed.');
c = capture(); if (await runCli(['import', fixture, '--project', project, '--alias', 'fixture', '--json'], c.io) !== 0) throw new Error('Skill import example failed.');
c = capture(); if (await runCli(['inspect', '--project', project, '--alias', 'fixture', '--json'], c.io) !== 0) throw new Error('Skill screen query example failed.');
c = capture(); if (await runCli(['inspect', '--project', project, '--alias', 'fixture', '--node-id', '1:2', '--json'], c.io) !== 0) throw new Error('Skill node query example failed.');
if (await stat(join(process.cwd(), 'dist', 'cli.js')).then(value => value.isFile()).catch(() => false)) {
  const subprocessProject = join(root, 'subprocess-project');
  const subprocess = await execFile(process.execPath, [join(process.cwd(), 'dist', 'cli.js'), 'init', '--project', subprocessProject, '--json'], { windowsHide: true });
  if (JSON.parse(subprocess.stdout).schemaVersion !== 1 || subprocess.stderr.trim() !== '') throw new Error('Built CLI subprocess smoke failed or wrote diagnostics to stdout.');
}
console.log(`Aphrodite skill copied/discovered and CLI smoke passed (${copied}).`);
