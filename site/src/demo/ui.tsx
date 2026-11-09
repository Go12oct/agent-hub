import type { AgentKey } from './engine'

export const agentColor: Record<AgentKey, string> = {
  claude: 'var(--color-claude)', codex: 'var(--color-codex)', devin: 'var(--color-devin)', agy: 'var(--color-agy)',
}
const marks: Record<AgentKey, string> = { claude: 'CL', codex: 'CX', devin: 'DV', agy: 'AG' }
export const ease = [0.22, 1, 0.36, 1] as const

export function Mark({ agent, size = 22 }: { agent: AgentKey; size?: number }) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-[6px] border border-line bg-raised font-mono font-medium"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42), color: agentColor[agent] }}
      aria-hidden
    >
      {marks[agent]}
    </span>
  )
}
