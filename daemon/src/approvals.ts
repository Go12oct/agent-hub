import { randomUUID } from 'node:crypto';
import type { PendingApproval } from '@agent-hub/shared';

export type ApprovalDecision = 'allow' | 'deny';
export type ApprovalOutcome = ApprovalDecision | 'timeout' | 'cancelled';

interface Held {
  approval: PendingApproval;
  sessionId: string;
  resolve: (outcome: ApprovalOutcome) => void;
}

export function summarizeToolRequest(toolName: string, input: Record<string, unknown> = {}): { summary: string; detail?: string } {
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

  hold(sessionId: string, toolName: string, input: Record<string, unknown> | undefined, holdMs: number): { approval: PendingApproval; outcome: Promise<ApprovalOutcome> } {
    const { summary, detail } = summarizeToolRequest(toolName, input);
    const approval: PendingApproval = { id: randomUUID(), toolName, summary, detail, requestedAt: new Date().toISOString() };
    let settle!: (outcome: ApprovalOutcome) => void;
    const outcome = new Promise<ApprovalOutcome>((resolve) => { settle = resolve; });
    let timer: NodeJS.Timeout | undefined;
    const resolve = (result: ApprovalOutcome) => {
      if (timer) clearTimeout(timer);
      if (!this.held.delete(approval.id)) return;
      settle(result);
      this.onChange?.(sessionId);
    };
    timer = setTimeout(() => resolve('timeout'), holdMs);
    this.held.set(approval.id, { approval, sessionId, resolve });
    this.onChange?.(sessionId);
    return { approval, outcome };
  }

  pending(sessionId: string): PendingApproval[] {
    return [...this.held.values()].filter((held) => held.sessionId === sessionId).map((held) => held.approval);
  }

  decide(sessionId: string, approvalId: string | undefined, decision: ApprovalDecision): 'ok' | 'none' | 'stale' {
    const mine = [...this.held.values()].filter((held) => held.sessionId === sessionId);
    if (!mine.length) return 'none';
    const target = approvalId ? mine.find((held) => held.approval.id === approvalId) : mine[0];
    if (!target) return 'stale';
    target.resolve(decision);
    return 'ok';
  }

  cancel(approvalId: string): void {
    this.held.get(approvalId)?.resolve('cancelled');
  }

  cancelSession(sessionId: string, toolName?: string): void {
    const mine = [...this.held.values()].filter((held) => held.sessionId === sessionId);
    if (toolName) {
      const match = mine.find((held) => held.approval.toolName === toolName);
      if (match) match.resolve('cancelled');
      return;
    }
    for (const held of mine) held.resolve('cancelled');
  }

  cancelAll(): void {
    for (const held of [...this.held.values()]) held.resolve('cancelled');
  }
}

export function hookDecisionBody(outcome: ApprovalOutcome): Record<string, unknown> {
  if (outcome === 'allow') {
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
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
