import { z } from 'zod';

export const WorkstationModeSchema = z.enum([
  'command',
  'inspect-repo',
  'git-status',
  'git-log',
  'bun',
  'kubectl-get',
  'read-file',
  'write-file',
  'systemd-restart',
]);

export const WorkstationAgentInputSchema = z.object({
  mode: WorkstationModeSchema.default('command')
    .describe('Deterministic workstation action to execute'),
  task: z.string().optional()
    .describe('Legacy freeform task text. In command mode, treated as the shell command if command is unset'),
  command: z.string().optional()
    .describe('Shell command to execute in command mode'),
  path: z.string().optional()
    .describe('File path for read-file or write-file modes'),
  content: z.string().optional()
    .describe('File contents for write-file mode'),
  script: z.string().optional()
    .describe('Bun script or arguments for bun mode'),
  resource: z.string().optional()
    .describe('kubectl resource selector for kubectl-get mode'),
  unit: z.string().optional()
    .describe('systemd unit for systemd-restart mode'),
  gitLogCount: z.coerce.number().int().positive().default(10)
    .describe('Number of commits to show for git-log mode'),
  workDir: z.string().default('/home/pedro/PeteDio-Labs')
    .describe('Working directory for shell commands and file operations'),
  gated: z.boolean().default(false)
    .describe('Enable gated (destructive) tools: write_file, git_commit, git_push, systemd_restart'),
}).superRefine((input, ctx) => {
  if (input.mode === 'command' && !input.command && !input.task) {
    ctx.addIssue({ code: 'custom', message: 'command mode requires command or task' });
  }
  if ((input.mode === 'read-file' || input.mode === 'write-file') && !input.path) {
    ctx.addIssue({ code: 'custom', message: `${input.mode} mode requires path` });
  }
  if (input.mode === 'write-file' && input.content === undefined) {
    ctx.addIssue({ code: 'custom', message: 'write-file mode requires content' });
  }
  if (input.mode === 'bun' && !input.script) {
    ctx.addIssue({ code: 'custom', message: 'bun mode requires script' });
  }
  if (input.mode === 'kubectl-get' && !input.resource) {
    ctx.addIssue({ code: 'custom', message: 'kubectl-get mode requires resource' });
  }
  if (input.mode === 'systemd-restart' && !input.unit) {
    ctx.addIssue({ code: 'custom', message: 'systemd-restart mode requires unit' });
  }
});

export type WorkstationAgentInput = z.infer<typeof WorkstationAgentInputSchema>;
