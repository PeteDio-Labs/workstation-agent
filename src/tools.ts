/**
 * Tool definitions for the workstation-agent Gemma 4 loop.
 * Always-allowed tools: exec_shell, read_file, git_status, git_log, bun_run, kubectl_get
 * Gated tools (destructive, require gated=true): write_file, git_commit, git_push, systemd_restart
 */

import type { ToolDef } from '@petedio/shared/agents';

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

export function buildTools(gated: boolean, workDir: string): ToolDef[] {
  const always: ToolDef[] = [
    {
      name: 'exec_shell',
      description: 'Execute a shell command on the workstation. Dangerous patterns (rm -rf /, mkfs, dd if=, fork bombs) are blocked.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run' },
          cwd: { type: 'string', description: 'Working directory override (defaults to task workDir)' },
        },
        required: ['command'],
      },
      async execute(rawArgs) {
        const args = rawArgs as { command: string; cwd?: string };
        const blocked = checkShellCommand(args.command);
        if (blocked) return blocked;
        return spawnCommand(args.command, args.cwd ?? workDir);
      },
    },

    {
      name: 'read_file',
      description: 'Read the contents of a file on the workstation.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative file path to read' },
        },
        required: ['path'],
      },
      async execute(rawArgs) {
        const args = rawArgs as { path: string };
        try {
          const file = Bun.file(args.path);
          const exists = await file.exists();
          if (!exists) return `File not found: ${args.path}`;
          const text = await file.text();
          return text || '(empty file)';
        } catch (err) {
          return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },

    {
      name: 'git_status',
      description: 'Get the current git status of a repository directory.',
      parameters: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Repository directory (defaults to task workDir)' },
        },
      },
      async execute(rawArgs) {
        const args = rawArgs as { cwd?: string };
        return spawnCommand('git status', args.cwd ?? workDir);
      },
    },

    {
      name: 'git_log',
      description: 'Get recent git commit log for a repository.',
      parameters: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Repository directory (defaults to task workDir)' },
          n: { type: 'number', description: 'Number of commits to show (default 10)' },
        },
      },
      async execute(rawArgs) {
        const args = rawArgs as { cwd?: string; n?: number };
        const n = args.n ?? 10;
        return spawnCommand(`git log --oneline -${n}`, args.cwd ?? workDir);
      },
    },

    {
      name: 'bun_run',
      description: 'Run a bun script or command in a project directory.',
      parameters: {
        type: 'object',
        properties: {
          script: { type: 'string', description: 'Script name or bun command arguments (e.g. "test", "run build")' },
          cwd: { type: 'string', description: 'Project directory (defaults to task workDir)' },
        },
        required: ['script'],
      },
      async execute(rawArgs) {
        const args = rawArgs as { script: string; cwd?: string };
        return spawnCommand(`bun ${args.script}`, args.cwd ?? workDir);
      },
    },

    {
      name: 'kubectl_get',
      description: 'Run a read-only kubectl get command against the cluster.',
      parameters: {
        type: 'object',
        properties: {
          resource: { type: 'string', description: 'Resource type and optional name (e.g. "pods -n mission-control", "nodes")' },
        },
        required: ['resource'],
      },
      async execute(rawArgs) {
        const args = rawArgs as { resource: string };
        return spawnCommand(`kubectl get ${args.resource}`, workDir);
      },
    },
  ];

  if (!gated) return always;

  const gatedTools: ToolDef[] = [
    {
      name: 'write_file',
      description: '[GATED] Write content to a file on the workstation. Creates or overwrites the file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative file path to write' },
          content: { type: 'string', description: 'Content to write to the file' },
        },
        required: ['path', 'content'],
      },
      async execute(rawArgs) {
        const args = rawArgs as { path: string; content: string };
        try {
          await Bun.write(args.path, args.content);
          return `Written: ${args.path} (${args.content.length} bytes)`;
        } catch (err) {
          return `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },

    {
      name: 'git_commit',
      description: '[GATED] Stage all changes and create a git commit.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Commit message' },
          cwd: { type: 'string', description: 'Repository directory (defaults to task workDir)' },
        },
        required: ['message'],
      },
      async execute(rawArgs) {
        const args = rawArgs as { message: string; cwd?: string };
        const dir = args.cwd ?? workDir;
        const safeMessage = args.message.replace(/'/g, "'\\''");
        return spawnCommand(`git add -A && git commit -m '${safeMessage}'`, dir);
      },
    },

    {
      name: 'git_push',
      description: '[GATED] Push the current branch to the remote origin.',
      parameters: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Repository directory (defaults to task workDir)' },
          branch: { type: 'string', description: 'Branch to push (defaults to current branch)' },
        },
      },
      async execute(rawArgs) {
        const args = rawArgs as { cwd?: string; branch?: string };
        const dir = args.cwd ?? workDir;
        const cmd = args.branch ? `git push origin ${args.branch}` : 'git push';
        return spawnCommand(cmd, dir);
      },
    },

    {
      name: 'systemd_restart',
      description: `[GATED] Restart a systemd service. Only allowed units: ${ALLOWED_SYSTEMD_UNITS.join(', ')}.`,
      parameters: {
        type: 'object',
        properties: {
          unit: { type: 'string', description: 'Systemd unit name (without .service suffix)' },
        },
        required: ['unit'],
      },
      async execute(rawArgs) {
        const args = rawArgs as { unit: string };
        const unitName = args.unit.replace(/\.service$/, '');
        if (!ALLOWED_SYSTEMD_UNITS.includes(unitName)) {
          return `Blocked: '${unitName}' is not in the allowed unit list (${ALLOWED_SYSTEMD_UNITS.join(', ')})`;
        }
        return spawnCommand(`systemctl restart ${unitName}.service`, workDir);
      },
    },
  ];

  return [...always, ...gatedTools];
}
