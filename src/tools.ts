import type { z } from 'zod';
import type { WorkstationAgentInput, WorkstationModeSchema } from './schema.js';

export type WorkstationAction = z.infer<typeof WorkstationModeSchema>;

export interface WorkstationStep {
  title: string;
  action: WorkstationAction;
  args?: Record<string, unknown>;
}

export interface WorkstationStepLog {
  step: WorkstationStep;
  status: 'complete' | 'failed';
  output: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

const BLOCKED_PATTERNS = [
  /rm\s+-rf\s+\//,
  /mkfs/,
  /dd\s+if=/,
  /:\(\)\s*\{.*:\|:/,
];

const ALLOWED_SYSTEMD_UNITS = [
  'ops-investigator',
  'pm-agent',
  'knowledge-janitor',
  'workstation-agent',
  'infra-agent',
  'blog-agent',
];

function checkShellCommand(cmd: string): string | null {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(cmd)) {
      return `Blocked: command matches dangerous pattern (${pattern.source})`;
    }
  }
  return null;
}

async function spawnCommand(cmd: string, cwd: string): Promise<string> {
  const proc = Bun.spawn(['bash', '-c', cmd], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const out = stdout.trim();
  const err = stderr.trim();

  if (exitCode !== 0) {
    return [
      `Exit code: ${exitCode}`,
      out ? `stdout:\n${out}` : '',
      err ? `stderr:\n${err}` : '',
    ].filter(Boolean).join('\n');
  }

  return out || err || '(no output)';
}

function requireGated(gated: boolean, action: string): void {
  if (!gated) {
    throw new Error(`${action} requires gated=true`);
  }
}

async function readFile(path: string): Promise<string> {
  try {
    const file = Bun.file(path);
    const exists = await file.exists();
    if (!exists) return `File not found: ${path}`;
    const text = await file.text();
    return text || '(empty file)';
  } catch (err) {
    return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function writeFile(path: string, content: string): Promise<string> {
  try {
    await Bun.write(path, content);
    return `Written: ${path} (${content.length} bytes)`;
  } catch (err) {
    return `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export function buildPlan(input: WorkstationAgentInput): WorkstationStep[] {
  switch (input.mode) {
    case 'inspect-repo':
      return [
        { title: 'Inspect git status', action: 'git-status' },
        { title: 'Inspect recent commits', action: 'git-log', args: { n: input.gitLogCount } },
      ];
    case 'git-status':
      return [{ title: 'Inspect git status', action: 'git-status' }];
    case 'git-log':
      return [{ title: 'Inspect recent commits', action: 'git-log', args: { n: input.gitLogCount } }];
    case 'bun':
      return [{ title: `Run bun ${input.script}`, action: 'bun', args: { script: input.script } }];
    case 'kubectl-get':
      return [{ title: `Run kubectl get ${input.resource}`, action: 'kubectl-get', args: { resource: input.resource } }];
    case 'read-file':
      return [{ title: `Read ${input.path}`, action: 'read-file', args: { path: input.path } }];
    case 'write-file':
      return [{ title: `Write ${input.path}`, action: 'write-file', args: { path: input.path, content: input.content } }];
    case 'systemd-restart':
      return [{ title: `Restart ${input.unit}`, action: 'systemd-restart', args: { unit: input.unit } }];
    case 'command':
    default:
      return [{ title: `Run command`, action: 'command', args: { command: input.command ?? input.task } }];
  }
}

export async function executeStep(step: WorkstationStep, opts: { gated: boolean; workDir: string }): Promise<string> {
  const { gated, workDir } = opts;

  switch (step.action) {
    case 'command': {
      const command = String(step.args?.command ?? '');
      const blocked = checkShellCommand(command);
      if (blocked) return blocked;
      return spawnCommand(command, workDir);
    }
    case 'inspect-repo':
      return 'inspect-repo is a planning-only action';
    case 'git-status':
      return spawnCommand('git status', workDir);
    case 'git-log': {
      const n = Number(step.args?.n ?? 10);
      return spawnCommand(`git log --oneline -${n}`, workDir);
    }
    case 'bun':
      return spawnCommand(`bun ${String(step.args?.script ?? '')}`, workDir);
    case 'kubectl-get':
      return spawnCommand(`kubectl get ${String(step.args?.resource ?? '')}`, workDir);
    case 'read-file':
      return readFile(String(step.args?.path ?? ''));
    case 'write-file':
      requireGated(gated, 'write-file');
      return writeFile(String(step.args?.path ?? ''), String(step.args?.content ?? ''));
    case 'systemd-restart': {
      requireGated(gated, 'systemd-restart');
      const unitName = String(step.args?.unit ?? '').replace(/\.service$/, '');
      if (!ALLOWED_SYSTEMD_UNITS.includes(unitName)) {
        return `Blocked: '${unitName}' is not in the allowed unit list (${ALLOWED_SYSTEMD_UNITS.join(', ')})`;
      }
      return spawnCommand(`systemctl restart ${unitName}.service`, workDir);
    }
  }
}

export function formatReport(logs: WorkstationStepLog[]): string {
  if (logs.length === 0) return 'No steps executed.';

  return logs.map((log, index) => {
    const lines = [
      `${index + 1}. ${log.step.title} [${log.status}]`,
      `action: ${log.step.action}`,
      `duration: ${log.durationMs}ms`,
    ];
    if (log.output) {
      lines.push('output:');
      lines.push(log.output);
    }
    return lines.join('\n');
  }).join('\n\n');
}
