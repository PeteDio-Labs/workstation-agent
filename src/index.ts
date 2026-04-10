/**
 * workstation-agent — Workstation automation agent.
 *
 * Accepts a TaskPayload from MC Backend, runs a Gemma 4 tool-calling loop
 * over shell, file, git, bun, kubectl, and systemd tools, produces a
 * completion report, and reports back to MC.
 *
 * Also exposes an Express HTTP server so MC Backend can POST tasks.
 */

import express from 'express';
import pino from 'pino';
import { z } from 'zod';
import { AgentReporter, runToolLoop } from '@petedio/shared/agents';
import { TaskPayloadSchema } from '@petedio/shared/agents';
import { WorkstationAgentInputSchema } from './schema.js';
import { buildTools } from './tools.js';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const PORT = parseInt(process.env.PORT ?? '3008', 10);
const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://192.168.50.59:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'gemma4';
const MC_BACKEND_URL = process.env.MC_BACKEND_URL ?? 'http://localhost:3000';

// ─── Agent Logic ─────────────────────────────────────────────────

async function runTask(payload: z.infer<typeof TaskPayloadSchema>): Promise<void> {
  const startMs = Date.now();
  const input = WorkstationAgentInputSchema.parse(payload.input);

  const reporter = new AgentReporter({
    mcUrl: MC_BACKEND_URL,
    taskId: payload.taskId,
    agentName: 'workstation-agent',
  });

  await reporter.running('Executing workstation task...');
  log.info({ taskId: payload.taskId, input }, 'workstation-agent starting');

  const gateNote = input.gated
    ? 'Gated mode is ENABLED — write_file, git_commit, git_push, and systemd_restart are available.'
    : 'Gated mode is DISABLED — only read-only and non-destructive tools are available.';

  const userPrompt = `
Task: ${input.task}

Working directory: ${input.workDir}
${gateNote}

Complete the task using the available tools. When done, summarise what was accomplished and any relevant output or findings.
`.trim();

  try {
    const { finalResponse, toolCallLog, iterations } = await runToolLoop({
      ollamaUrl: OLLAMA_URL,
      model: OLLAMA_MODEL,
      system: 'You are a workstation automation agent running on LXC 113. Execute tasks efficiently using the available tools. For destructive operations, only proceed if gated mode is enabled.',
      userPrompt,
      tools: buildTools(input.gated, input.workDir),
      onIteration: (i, content) => {
        if (content) log.info({ taskId: payload.taskId, iteration: i }, 'loop response');
      },
    });

    const durationMs = Date.now() - startMs;
    log.info({ taskId: payload.taskId, iterations, durationMs }, 'task complete');

    const toolSummary = toolCallLog.length > 0
      ? `\n\n---\n**Tools used:** ${[...new Set(toolCallLog.map(t => t.tool))].join(', ')}`
      : '';

    await reporter.complete({
      taskId: payload.taskId,
      agentName: 'workstation-agent',
      status: 'complete',
      summary: firstLine(finalResponse),
      artifacts: [
        {
          type: 'log',
          label: 'Workstation Task Report',
          content: finalResponse + toolSummary,
        },
      ],
      durationMs,
      completedAt: new Date().toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ taskId: payload.taskId, err: msg }, 'task failed');
    await reporter.fail(msg);
  }
}

function firstLine(text: string): string {
  return text.split('\n').find(l => l.trim().length > 0) ?? text.slice(0, 100);
}

// ─── HTTP Server ──────────────────────────────────────────────────

const app = express();
app.use(express.json());

// MC Backend POSTs here to dispatch a task
app.post('/run', async (req, res) => {
  const parsed = TaskPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid task payload', details: parsed.error.flatten() });
    return;
  }

  res.json({ accepted: true, taskId: parsed.data.taskId });

  // Run async — don't await (MC doesn't wait for completion)
  runTask(parsed.data).catch(err => {
    log.error({ err: err instanceof Error ? err.message : err }, 'Unhandled task error');
  });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', agent: 'workstation-agent', model: OLLAMA_MODEL });
});

app.listen(PORT, () => {
  log.info({ port: PORT, model: OLLAMA_MODEL }, 'workstation-agent listening');
});
