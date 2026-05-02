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

const GREP_REPLACE_CATCHALL = [/^\.\*$/, /^\.\+$/, /^\.\+@\.\+$/];
const GREP_REPLACE_MAX_FILES = 50;

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

function checkGrepPattern(pattern: string): string | null {
  if (pattern.length < 4) {
    return `Refused: pattern length < 4 chars ("${pattern}"). Use a more specific pattern.`;
  }
  if (/^[\s./]*$/.test(pattern)) {
    return `Refused: pattern is whitespace/dots/slashes only. Use a more specific pattern.`;
  }
  for (const re of GREP_REPLACE_CATCHALL) {
    if (re.test(pattern)) {
      return `Refused: pattern is too broad ("${pattern}"). Use a more specific pattern.`;
    }
  }
  if (pattern.includes('/')) {
    return `Refused: pattern must not contain '/' (used as sed delimiter). Replace '/' with '\\/' in the regex if needed.`;
  }
  return null;
}

async function findGrepMatches(pattern: string, pathGlob: string | undefined, cwd: string): Promise<string[]> {
  const args: string[] = ['rg', '-l', '--null', pattern];
  if (pathGlob && pathGlob.trim().length > 0) {
    const parts = pathGlob.split(/\s+/).filter(Boolean);
    args.push(...parts);
  }
  const proc = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [out, errOut, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode === 0) {
    return out.split('\0').map(s => s.trim()).filter(Boolean);
  }
  if (exitCode === 1) {
    return [];
  }
  throw new Error(`rg failed (exit ${exitCode}): ${errOut.trim() || '(no stderr)'}`);
}

async function applySedReplacements(
  files: string[],
  pattern: string,
  replacement: string,
  cwd: string,
): Promise<string> {
  const escapedReplacement = replacement
    .replace(/\\/g, '\\\\')
    .replace(/\//g, '\\/')
    .replace(/&/g, '\\&');
  const sedExpr = `s/${pattern}/${escapedReplacement}/g`;

  const results: string[] = [];
  for (const file of files) {
    const proc = Bun.spawn(['sed', '-i', '-E', '-e', sedExpr, file], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [errOut, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    results.push(exitCode === 0 ? `OK ${file}` : `FAILED ${file}: ${errOut.trim() || `exit ${exitCode}`}`);
  }
  return results.join('\n');
}

async function grepReplace(
  args: { pattern: string; replacement?: string; pathGlob?: string; dryRun: boolean; gated: boolean; cwd: string },
): Promise<string> {
  const patternErr = checkGrepPattern(args.pattern);
  if (patternErr) return patternErr;

  let files: string[];
  try {
    files = await findGrepMatches(args.pattern, args.pathGlob, args.cwd);
  } catch (err) {
    return `Error running ripgrep: ${err instanceof Error ? err.message : String(err)}`;
  }

  const header = `Pattern: ${args.pattern}\nPath: ${args.pathGlob ?? '(repo root)'}\nMatched ${files.length} file(s).`;

  if (files.length === 0) {
    return `${header}\n(no matches)`;
  }

  if (args.dryRun) {
    return `${header}\n${files.join('\n')}`;
  }

  if (!args.gated) {
    return `${header}\nRefused: apply requires gated=true. Currently dryRun=false but gated=false.`;
  }

  if (files.length > GREP_REPLACE_MAX_FILES) {
    return `${header}\nRefused: matched files (${files.length}) exceeds circuit-breaker max (${GREP_REPLACE_MAX_FILES}). Narrow the pathGlob and re-run.`;
  }

  if (args.replacement === undefined) {
    return `${header}\nRefused: apply requires replacement.`;
  }

  const replaceLog = await applySedReplacements(files, args.pattern, args.replacement, args.cwd);
  return `${header}\nReplacement: ${args.replacement}\n\n${replaceLog}`;
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
    case 'grep-replace':
      return [{
        title: input.dryRun
          ? `Find files matching ${input.pattern}`
          : `Replace ${input.pattern} → ${input.replacement} in matched files`,
        action: 'grep-replace',
        args: {
          pattern: input.pattern,
          replacement: input.replacement,
          pathGlob: input.pathGlob,
          dryRun: input.dryRun,
        },
      }];
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
    case 'grep-replace': {
      const pattern = String(step.args?.pattern ?? '');
      const replacement = step.args?.replacement === undefined ? undefined : String(step.args.replacement);
      const pathGlob = step.args?.pathGlob === undefined ? undefined : String(step.args.pathGlob);
      const dryRun = step.args?.dryRun !== false;
      return grepReplace({ pattern, replacement, pathGlob, dryRun, gated, cwd: workDir });
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
