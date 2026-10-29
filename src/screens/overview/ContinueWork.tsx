import { useEffect } from 'react'
import { ArrowUpRight, SquareTerminal } from 'lucide-react'
import { useGrid } from '@/terminals/store'
import { useStore } from '@/store'
import { plural } from '@/lib/format'

export function ContinueWork() {
  const sessions = useGrid((s) => s.sessions)
  const activeId = useGrid((s) => s.activeId)
  const ws = useGrid((s) => s.ws)
  const infos = useGrid((s) => s.infos)
  const restored = useGrid((s) => s.restored)
  useEffect(() => { void useGrid.getState().restore() }, [])
  const running = sessions.map((session) => ({
    session,
    count: (session.id === activeId ? ws : session.ws).panes.filter((p) => p.terminalId && infos[p.terminalId]?.exited === false).length
  })).filter((item) => item.count > 0)
  if (!restored || !running.length) return null
  return (
    <section aria-label="Continue working" className="flex flex-wrap items-center gap-3 rounded-lg border border-rivet bg-deck px-4 py-3">
      <span className="mr-1 flex items-center gap-2 text-xs font-medium text-muted"><SquareTerminal size={15} /> In progress</span>
      {running.map(({ session, count }) => (
        <button key={session.id} className="btn btn-sm" onClick={() => {
          useGrid.getState().switchSession(session.id)
          useStore.getState().go('terminals')
        }} aria-label={`Continue ${session.name}, ${plural(count, 'running terminal')}`}>
          {session.name}<span className="text-muted">{count} running</span><ArrowUpRight size={13} />
        </button>
      ))}
    </section>
  )
}
