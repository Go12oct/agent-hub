import type { AgentSession, SessionMessage } from '@agent-hub/shared';

export type EmitSession = ((session: AgentSession) => void) & { remove?: (id: string) => void };

export interface Collector {
  name: string;
  start(emit: EmitSession): void;
  stop(): void;
  getMessages(nativeId: string, limit: number): Promise<SessionMessage[]>;
}
