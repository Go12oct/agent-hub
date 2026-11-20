import type { SessionStatus } from '@agent-hub/shared';

export interface HookOverride {
  status: SessionStatus;
  at: number;
  event: string;
  message?: string;
}

const notificationPromptTtlMs = 30 * 60_000;

function expired(hook: HookOverride, now: number, approvalHoldMs: number): boolean {
  if (hook.status !== 'needs_input') return false;
  if (hook.event === 'PermissionRequest') return now - hook.at > approvalHoldMs + 60_000;
  if (hook.event === 'Notification') return now - hook.at > notificationPromptTtlMs;
  return false;
}

export function activeHookOverride(
  overrides: Map<string, HookOverride>,
  nativeId: string,
  now: number,
  approvalHoldMs: number,
): HookOverride | undefined {
  const hook = overrides.get(nativeId);
  if (hook && expired(hook, now, approvalHoldMs)) {
    overrides.delete(nativeId);
    return undefined;
  }
  return hook;
}

export function hookOverrideForFile(
  fileModifiedAt: number,
  hook: HookOverride,
  now: number,
  approvalHoldMs: number,
): HookOverride | undefined {
  if (expired(hook, now, approvalHoldMs) || fileModifiedAt > hook.at) return undefined;
  return hook;
}
