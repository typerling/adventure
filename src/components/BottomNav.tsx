import { Link, useLocation } from 'react-router-dom'
import { Compass, BookOpen, Settings as SettingsIcon, type LucideIcon } from 'lucide-react'
import { usePlayHeaderStore } from '@/store/playHeaderStore'
import { cn } from '@/lib/utils'

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  match: string
}

/**
 * Mobile bottom tab bar for the three campaign-scoped screens (Play/Codex/Settings) — a phone
 * screen doesn't have room for the top header's icon row *and* a thumb-reachable nav, so this
 * takes over campaign navigation below the `md` breakpoint while the header keeps handling it on
 * larger screens. Only renders once a campaign context is registered (see playHeaderStore) —
 * Dashboard/NewCampaign have nothing campaign-scoped to navigate between.
 */
export function BottomNav() {
  const context = usePlayHeaderStore((s) => s.context)
  const location = useLocation()

  if (!context) return null

  const items: NavItem[] = [
    { to: `/play/${context.campaignId}`, label: 'Adventure', icon: Compass, match: '/play' },
    { to: `/codex/${context.campaignId}`, label: 'Codex', icon: BookOpen, match: '/codex' },
    { to: `/settings/${context.campaignId}`, label: 'Settings', icon: SettingsIcon, match: '/settings' },
  ]

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border/70 bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-sm md:hidden"
      aria-label="Campaign navigation"
    >
      <div className="mx-auto flex max-w-3xl items-stretch justify-around">
        {items.map(({ to, label, icon: Icon, match }) => {
          const active = location.pathname.startsWith(match)
          return (
            <Link
              key={to}
              to={to}
              className={cn(
                'flex flex-1 flex-col items-center gap-1 px-2 py-2.5 text-[0.65rem] font-medium tracking-wide uppercase transition-colors',
                active ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon className="size-5" strokeWidth={active ? 2.25 : 1.75} />
              {label}
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
