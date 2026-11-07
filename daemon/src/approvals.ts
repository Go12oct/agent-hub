import { randomUUID } from 'node:crypto';
import type { PendingApproval } from '@agent-hub/shared';

export type ApprovalDecision = 'allow' | 'deny';
export type ApprovalOutcome = ApprovalDecision | 'timeout' | 'cancelled';

export interface ApprovalResolution {
  outcome: ApprovalOutcome;
  toolName: string;
  input: Record<string, unknown>;
  answers?: Record<string, string>;
}

interface Held {
  approval: PendingApproval;
  sessionId: string;
  input: Record<string, unknown>;
  inputKey: string;
  resolve: (outcome: ApprovalOutcome, answers?: Record<string, string>) => void;
}

export function inputKey(toolName: string, input: Record<string, unknown> | undefined): string {
  return `${toolName}\u0000${JSON.stringify(input ?? {})}`;
}

export function summarizeToolRequest(toolName: string, input: Record<string, unknown> = {}): { summary: string; detail?: string; questions?: PendingApproval['questions'] } {
  const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
  switch (toolName) {
    case 'Bash': {
      const command = text(input.command) || '';
      return { summary: `Run: ${command}`.slice(0, 280), detail: text(input.description) };
    }
    case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit':
      return { summary: `${toolName === 'Write' ? 'Write' : 'Edit'} ${text(input.file_path) || text(input.notebook_path) || 'a file'}`.slice(0, 280) };
    case 'Read':
      return { summary: `Read ${text(input.file_path) || 'a file'}`.slice(0, 280) };
    case 'WebFetch':
      return { summary: `Fetch ${text(input.url) || 'a URL'}`.slice(0, 280) };
    case 'WebSearch':
      return { summary: `Search the web: ${text(input.query) || ''}`.slice(0, 280) };
    case 'AskUserQuestion': {
      const questions = Array.isArray(input.questions) ? input.questions.flatMap((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
        const question = value as Record<string, unknown>;
        if (typeof question.question !== 'string' || !Array.isArray(question.options)) return [];
        const options = question.options.flatMap((option) => {
          if (!option || typeof option !== 'object' || Array.isArray(option)) return [];
          const item = option as Record<string, unknown>;
          if (typeof item.label !== 'string') return [];
          return [{ label: item.label, ...(typeof item.description === 'string' ? { description: item.description } : {}) }];
        });
        return [{
          question: question.question,
          ...(typeof question.header === 'string' ? { header: question.header } : {}),
          ...(typeof question.multiSelect === 'boolean' ? { multiSelect: question.multiSelect } : {}),
          options,
        }];
      }) : [];
      return { summary: `Claude has a question: ${questions[0]?.question || 'Please answer this question.'}`, ...(questions.length ? { questions } : {}) };
    }
    case 'ExitPlanMode':
      return { summary: 'Start implementing the plan' };
    default: {
      const detail = Object.keys(input).length ? JSON.stringify(input).slice(0, 1000) : undefined;
      return { summary: `Use ${toolName}`, detail };
    }
  }
}

export class ApprovalBroker {
  private held = new Map<string, Held>();
  onChange?: (sessionId: string) => void;

  hold(sessionId: string, toolName: string, input: Record<string, unknown> | undefined, holdMs: number): { approval: PendingApproval; outcome: Promise<ApprovalResolution> } {
    const originalInput = input ?? {};
    const { summary, detail, questions } = summarizeToolRequest(toolName, originalInput);
    const approval: PendingApproval = { id: randomUUID(), toolName, summary, detail, questions, requestedAt: new Date().toISOString() };
    let settle!: (outcome: ApprovalResolution) => void;
    const outcome = new Promise<ApprovalResolution>((resolve) => { settle = resolve; });
    let timer: NodeJS.Timeout | undefined;
    const resolve = (result: ApprovalOutcome, answers?: Record<string, string>) => {
      if (timer) clearTimeout(timer);
      if (!this.held.delete(approval.id)) return;
      settle({ outcome: result, toolName, input: originalInput, ...(answers ? { answers } : {}) });
      this.onChange?.(sessionId);
    };
    timer = setTimeout(() => resolve('timeout'), holdMs);
    this.held.set(approval.id, { approval, sessionId, input: originalInput, inputKey: inputKey(toolName, input), resolve });
    this.onChange?.(sessionId);
    return { approval, outcome };
  }

  pending(sessionId: string): PendingApproval[] {
    return [...this.held.values()].filter((held) => held.sessionId === sessionId).map((held) => held.approval);
  }

  decide(sessionId: string, approvalId: string | undefined, decision: ApprovalDecision, answers?: Record<string, string>): 'ok' | 'none' | 'stale' {
    const mine = [...this.held.values()].filter((held) => held.sessionId === sessionId);
    if (!mine.length) return 'none';
    const target = approvalId ? mine.find((held) => held.approval.id === approvalId) : mine[0];
    if (!target) return 'stale';
    target.resolve(decision, answers);
    return 'ok';
  }

  cancel(approvalId: string): void {
    this.held.get(approvalId)?.resolve('cancelled');
  }

  cancelSession(sessionId: string, tool?: { name: string; input?: Record<string, unknown> }): void {
    const mine = [...this.held.values()].filter((held) => held.sessionId === sessionId);
    if (!tool) {
      for (const held of mine) held.resolve('cancelled');
      return;
    }
    const exact = mine.find((held) => held.inputKey === inputKey(tool.name, tool.input));
    if (exact) { exact.resolve('cancelled'); return; }
    const sameTool = mine.filter((held) => held.approval.toolName === tool.name);
    if (sameTool.length === 1) sameTool[0]!.resolve('cancelled');
  }

  cancelAll(): void {
    for (const held of [...this.held.values()]) held.resolve('cancelled');
  }
}

export function hookDecisionBody(outcome: ApprovalOutcome, input?: Record<string, unknown>, answers?: Record<string, string>): Record<string, unknown> {
  if (outcome === 'allow') {
    const decision: { behavior: 'allow'; updatedInput?: Record<string, unknown> } = { behavior: 'allow' };
    if (input !== undefined) decision.updatedInput = answers ? { ...input, answers } : input;
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
  }
  if (outcome === 'deny') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'The user denied this from Agent Hub on their phone. Do not retry it; ask how to proceed.' },
      },
    };
  }
  return {};
}
