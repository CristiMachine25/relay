import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { Bell, Blocks, Check, Gauge, Library, PanelLeftClose, PanelLeftOpen, RefreshCw, Search, Settings, SquareTerminal, Users } from 'lucide-react'
import { useStore, type Screen } from '@/store'
import { IS_MOCK, api } from '@/api'
import { formatAgo } from '@/lib/format'
import { detectPlatform, isTauri, modKey } from '@/lib/platform'
import { useCollapsed } from '@/lib/collapse'
import { Logo } from './Logo'
import { Wordmark } from './Wordmark'

interface NavItem {
  id: Screen
  label: string
  icon: typeof Gauge
  key: string
}

const NAV: NavItem[] = [
  { id: 'overview', label: 'Start work', icon: Gauge, key: '1' },
  { id: 'terminals', label: 'Terminals', icon: SquareTerminal, key: '5' },
  { id: 'accounts', label: 'Accounts', icon: Users, key: '2' },
  { id: 'knowledge', label: 'Knowledge', icon: Library, key: '3' },
  { id: 'skills', label: 'Skills', icon: Blocks, key: '4' },
  { id: 'notifications', label: 'Notifications', icon: Bell, key: '6' }
]

/** Pinned to the bottom of the sidebar, away from the screens you switch between all day. */
const SETTINGS: NavItem = { id: 'settings', label: 'Settings', icon: Settings, key: '7' }

/**
 * On macOS the native window buttons sit in the sidebar's top row (`trafficLightPosition` in
 * tauri.conf.json centers them in its 56px height, x 16..76), so that row keeps them clear.
 */
export const MAC_TRAFFIC_LIGHTS = isTauri() && detectPlatform() === 'darwin'

export function Sidebar() {
  const screen = useStore((s) => s.screen)
  const go = useStore((s) => s.go)
  const setPalette = useStore((s) => s.setPalette)
  const unread = useStore((s) => s.notifications.filter((n) => !n.read).length)
  const usage = useStore((s) => s.usage)
  const now = useStore((s) => s.now)
  const refreshing = useStore((s) => s.refreshing)
  const refresh = useStore((s) => s.refresh)
  const [collapsed, setCollapsed] = useCollapsed('switchyard.sidebarCollapsed', () => window.innerWidth < 1000)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Terminals keep Ctrl+B for the program running in them.
      if ((e.target as HTMLElement).closest?.('.xterm')) return
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        setCollapsed(!collapsed)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [collapsed, setCollapsed])
  const toggleLabel = `${collapsed ? 'Expand' : 'Collapse'} sidebar (${modKey(api.platform)}+B)`

  const newest = Object.values(usage)
    .filter((u) => !u.stale)
    .map((u) => Date.parse(u.fetchedAt))
    .sort((a, b) => b - a)[0]

  const toggle = (className: string) => (
    <button
      onClick={() => setCollapsed(!collapsed)}
      className={clsx('h-8 w-8 shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-raised hover:text-ink', className)}
      data-tip={toggleLabel}
      data-tip-side="right"
      aria-label={toggleLabel}
      aria-expanded={!collapsed}
    >
      {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
    </button>
  )

  return (
    <nav
      aria-label="Main"
      className={clsx(
        'sidebar flex shrink-0 flex-col overflow-hidden border-r border-rivet bg-deck',
        collapsed ? clsx('sidebar-compact', MAC_TRAFFIC_LIGHTS ? 'w-[92px]' : 'w-[60px]') : 'w-[240px]'
      )}
    >
      <div
        data-tauri-drag-region="deep"
        className={clsx('flex h-14 shrink-0 items-center gap-2.5 px-4 compact:justify-center compact:px-0', MAC_TRAFFIC_LIGHTS && 'pl-[92px] pr-3')}
      >
        {!MAC_TRAFFIC_LIGHTS && <Logo size={26} />}
        <span className="sidebar-label flex flex-1 compact:hidden"><Wordmark /></span>
        {toggle('-mr-1.5 flex compact:hidden')}
      </div>
      <div className="flex items-center gap-1.5 px-3 pb-3 pt-2 compact:flex-col compact:px-2">
        {/* Collapsed, the header has no room beside the logo or the window buttons, so the toggle leads this column. */}
        {toggle('hidden compact:flex')}
        <button
          className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded border border-rivet bg-ground px-2.5 text-sm text-muted transition-colors hover:border-hop/60 hover:text-ink compact:w-9 compact:flex-none compact:justify-center compact:px-0"
          onClick={() => setPalette(true)}
          aria-label="Find and launch"
          data-tip={`Find and launch (${modKey(api.platform)}+K)`}
          data-tip-side="right"
        >
          <Search size={15} aria-hidden className="shrink-0" />
          <span className="sidebar-label flex-1 truncate text-left compact:hidden">Find and launch</span>
          <span className="sidebar-label whitespace-nowrap text-[11px] compact:hidden">{modKey(api.platform)} K</span>
        </button>
        <RefreshButton
          refreshing={refreshing}
          onRefresh={() => void refresh()}
          updated={newest ? formatAgo(new Date(newest).toISOString(), now) : null}
          usage={usage}
        />
      </div>
      <ul className="flex flex-col gap-1 overflow-y-auto px-3 compact:px-2">
        {NAV.map((n) => (
          <li key={n.id} className={clsx((n.id === 'knowledge' || n.id === 'notifications') && 'mt-3 border-t border-rivet pt-3')}>
            {n.id === 'knowledge' && <p className="sidebar-label mb-2 whitespace-nowrap px-2.5 text-xs font-medium text-muted compact:hidden">Tools and context</p>}
            <NavButton item={n} on={screen === n.id} onClick={() => go(n.id)}>
              {n.id === 'notifications' && unread > 0 && (
                <span
                  className="min-w-5 rounded-full bg-hop px-1.5 text-center text-[11px] font-bold leading-5 text-hop-ink compact:absolute compact:right-1 compact:top-0.5 compact:min-w-4 compact:px-1 compact:leading-4"
                  aria-label={`${unread} unread`}
                >
                  {unread}
                </span>
              )}
            </NavButton>
          </li>
        ))}
      </ul>

      <div className="mt-auto flex flex-col gap-2 p-3 compact:items-center compact:px-2">
        {IS_MOCK && (
          <p className="sidebar-label px-1 text-[11px] leading-4 text-faint compact:hidden">
            Browser preview with demo data. Nothing here touches your real accounts.
          </p>
        )}
        <NavButton item={SETTINGS} on={screen === SETTINGS.id} onClick={() => go(SETTINGS.id)} />
      </div>
    </nav>
  )
}

/** Refresh usage, beside search. It spins while refreshing and shows a check for a moment once new usage arrives. */
function RefreshButton({ refreshing, onRefresh, updated, usage }: { refreshing: boolean; onRefresh: () => void; updated: string | null; usage: unknown }) {
  const [done, setDone] = useState(false)
  // The usage seen when a refresh started: unchanged at the end means it failed (and the store showed an error).
  const startedWith = useRef<{ usage: unknown } | null>(null)
  useEffect(() => {
    if (refreshing) {
      startedWith.current = { usage }
      setDone(false)
      return
    }
    if (!startedWith.current) return
    const changed = startedWith.current.usage !== usage
    startedWith.current = null
    if (!changed) return
    setDone(true)
    const id = setTimeout(() => setDone(false), 1400)
    return () => clearTimeout(id)
    // Only the start and end of a refresh matter; usage is read at those moments.
  }, [refreshing])
  const label = refreshing ? 'Refreshing usage…' : `Refresh usage (R)${updated ? ` · updated ${updated}` : ''}`
  return (
    <button
      onClick={onRefresh}
      disabled={refreshing}
      aria-label={label}
      aria-busy={refreshing}
      data-tip={label}
      data-tip-side="right"
      className={clsx(
        'relative flex h-9 w-9 shrink-0 items-center justify-center rounded border border-rivet bg-ground text-muted transition-colors hover:border-hop/60 hover:text-ink disabled:cursor-default',
        refreshing && 'text-hop',
        done && 'border-full/50 text-full'
      )}
    >
      {done ? <Check key="done" size={15} className="pop-in" aria-hidden /> : <RefreshCw key="spin" size={15} className={clsx(refreshing && 'animate-spin')} aria-hidden />}
    </button>
  )
}

function NavButton({ item, on, onClick, children }: { item: NavItem; on: boolean; onClick: () => void; children?: React.ReactNode }) {
  const Icon = item.icon
  return (
    <button
      // Switch on press, like a native source list; click still covers the keyboard.
      onMouseDown={(e) => e.button === 0 && onClick()}
      onClick={onClick}
      aria-current={on ? 'page' : undefined}
      data-tip={`${item.label} (${item.key})`}
      data-tip-side="right"
      className={clsx(
        'relative flex h-10 w-full items-center gap-2.5 rounded px-2.5 text-sm compact:justify-center compact:px-0',
        on ? 'bg-hop/15 font-semibold text-hop' : 'text-muted transition-colors hover:bg-raised/60 hover:text-ink'
      )}
    >
      <Icon size={17} strokeWidth={on ? 2.2 : 1.8} className="shrink-0" />
      <span className="sidebar-label flex-1 whitespace-nowrap text-left compact:sr-only">{item.label}</span>
      {children}
    </button>
  )
}
