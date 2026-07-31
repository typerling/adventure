import { useState } from 'react'
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom'
import { BookOpen, MapPin, Mountain, Settings as SettingsIcon, Volume2, VolumeX } from 'lucide-react'
import { Toaster } from '@/components/ui/sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AuthGate } from '@/components/AuthGate'
import { BottomNav } from '@/components/BottomNav'
import { Dashboard } from '@/pages/Dashboard'
import { NewCampaign } from '@/pages/NewCampaign'
import { Play } from '@/pages/Play'
import { Codex } from '@/pages/Codex'
import { Settings } from '@/pages/Settings'
import { usePlayHeaderStore } from '@/store/playHeaderStore'
import { cn } from '@/lib/utils'

function Header() {
  const context = usePlayHeaderStore((s) => s.context)
  const readAloud = usePlayHeaderStore((s) => s.readAloud)
  const toggleReadAloud = usePlayHeaderStore((s) => s.toggleReadAloud)
  const [turnInfoOpen, setTurnInfoOpen] = useState(false)

  return (
    <header className="border-b border-border/70 bg-card/60">
      <div className="mx-auto flex max-w-3xl items-center justify-between gap-2 px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-1.5 truncate">
          <Link to="/" className="flex shrink-0 items-center gap-1.5 font-heading text-lg font-medium text-foreground">
            <Mountain className="size-4 text-primary" />
            Adventure
          </Link>
          {context && (
            <>
              <span className="text-muted-foreground">·</span>
              <Link
                to={`/play/${context.campaignId}`}
                title="Back to play"
                className="truncate font-heading text-lg text-foreground hover:text-primary"
              >
                {context.campaignName}
              </Link>
            </>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {context?.turnLabel && (
            <Button
              size="icon-sm"
              variant="outline"
              onClick={() => setTurnInfoOpen(true)}
              title={context.turnLabel}
              aria-label={context.turnLabel}
            >
              <MapPin className="size-4" />
            </Button>
          )}
          {context?.showReadAloudToggle && (
            <Button
              size="icon-sm"
              variant={readAloud ? 'default' : 'outline'}
              onClick={toggleReadAloud}
              aria-pressed={readAloud}
              title={readAloud ? 'Stop reading turns aloud' : 'Read new turns aloud'}
              aria-label={readAloud ? 'Stop reading turns aloud' : 'Read new turns aloud'}
            >
              {readAloud ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
            </Button>
          )}
          {/* Codex/Settings links are redundant with BottomNav once a campaign context exists,
              so they only need to reappear once the viewport is wide enough that BottomNav hides
              itself (md:hidden there, so md:inline-flex here mirrors it back). */}
          {context && (
            <Button size="icon-sm" variant="outline" className="hidden md:inline-flex" asChild>
              <Link to={`/codex/${context.campaignId}`} title="Codex" aria-label="Codex">
                <BookOpen className="size-4" />
              </Link>
            </Button>
          )}
          <Button
            size="icon-sm"
            variant="outline"
            className={cn(context && 'hidden md:inline-flex')}
            asChild
          >
            <Link
              to={context ? `/settings/${context.campaignId}` : '/settings'}
              title="Settings"
              aria-label="Settings"
            >
              <SettingsIcon className="size-4" />
            </Link>
          </Button>
        </div>
      </div>

      {context?.turnLabel && (
        <Dialog open={turnInfoOpen} onOpenChange={setTurnInfoOpen}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>Where you are</DialogTitle>
              <DialogDescription>{context.turnLabel}</DialogDescription>
            </DialogHeader>
          </DialogContent>
        </Dialog>
      )}
    </header>
  )
}

function AppShell() {
  const context = usePlayHeaderStore((s) => s.context)
  return (
    <div className="min-h-svh">
      <Header />
      <div className={cn(context && 'pb-16 md:pb-0')}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/new" element={<NewCampaign />} />
          <Route path="/play/:campaignId" element={<Play />} />
          <Route path="/codex/:campaignId" element={<Codex />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/settings/:campaignId" element={<Settings />} />
        </Routes>
      </div>
      <BottomNav />
    </div>
  )
}

function App() {
  return (
    // Derived from Vite's `base` (see vite.config.ts) so routes work both at the domain root in
    // dev and under /<repo>/ on GitHub Pages. Trailing slash stripped because React Router wants
    // a basename without one; "/" therefore becomes "" (i.e. no basename).
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
      <AuthGate>
        <AppShell />
      </AuthGate>
      <Toaster />
    </BrowserRouter>
  )
}

export default App
