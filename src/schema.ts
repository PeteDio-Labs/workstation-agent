import { z } from 'zod';
import { TaskPayloadSchema } from '@petedio/shared/agents';

export const WorkstationAgentInputSchema = z.object({
  task: z.string()
    .describe('Task description or instruction for the agent to execute'),
  workDir: z.string().default('/home/pedro/PeteDio-Labs')
    .describe('Working directory for shell commands and file operations'),
  gated: z.boolean().default(false)
    .describe('Enable gated (destructive) tools: write_file, git_commit, git_push, systemd_restart'),
});

export type WorkstationAgentInput = z.infer<typeof WorkstationAgentInputSchema>;

// TaskPayload.input typed as WorkstationAgentInput
export const WorkstationTaskPayloadSchema = TaskPayloadSchema.extend({
  input: WorkstationAgentInputSchema,
});
