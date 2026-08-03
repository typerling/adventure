import { useState } from 'react'
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom'
import { BookOpen, Loader2, MapPin, Pause, Play as PlayIcon, Settings as SettingsIcon } from 'lucide-react'
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
  const ttsControl = usePlayHeaderStore((s) => s.ttsControl)
  const [turnInfoOpen, setTurnInfoOpen] = useState(false)

  return (
    <header className="border-b border-border/70 bg-card/60">
      <div className="mx-auto flex max-w-3xl items-center justify-between gap-2 px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-1.5 truncate">
          {context ? (
            <>
              {/* Logo-only once a campaign name is showing — "Adventure - <name>" rarely both fit
                  next to each other, and the campaign name is the more useful thing to keep. */}
              <Link to="/" className="shrink-0" title="Adventure" aria-label="Adventure">
                <img src={`${import.meta.env.BASE_URL}favicon-32.png`} alt="" className="size-7 rounded-md" />
              </Link>
              <Link
                to={`/play/${context.campaignId}`}
                title="Back to play"
                className="truncate font-heading text-lg text-foreground hover:text-primary"
              >
                {context.campaignName}
              </Link>
            </>
          ) : (
            <Link to="/" className="flex shrink-0 items-center gap-1.5 font-heading text-lg font-medium text-foreground">
              <img src={`${import.meta.env.BASE_URL}favicon-32.png`} alt="" className="size-7 rounded-md" />
              Adventure
            </Link>
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
          {ttsControl && (
            <Button
              size="icon-sm"
              variant={ttsControl.status === 'playing' || ttsControl.status === 'paused' ? 'default' : 'outline'}
              onClick={ttsControl.toggle}
              disabled={ttsControl.status === 'loading'}
              title={
                ttsControl.status === 'loading'
                  ? 'Loading…'
                  : ttsControl.status === 'playing'
                    ? 'Pause playback'
                    : ttsControl.status === 'paused'
                      ? 'Resume playback'
                      : 'Play latest turn aloud'
              }
              aria-label={
                ttsControl.status === 'loading'
                  ? 'Loading…'
                  : ttsControl.status === 'playing'
                    ? 'Pause playback'
                    : ttsControl.status === 'paused'
                      ? 'Resume playback'
                      : 'Play latest turn aloud'
              }
            >
              {ttsControl.status === 'loading' ? (
                <Loader2 className="size-4 animate-spin" />
              ) : ttsControl.status === 'playing' ? (
                <Pause className="size-4" />
              ) : (
                <PlayIcon className="size-4" />
              )}
            </Button>
          )}
          {/* Codex is redundant with BottomNav once a campaign context exists, so it only needs
              to reappear once the viewport is wide enough that BottomNav hides itself (md:hidden
              there, so md:inline-flex here mirrors it back). Settings is device-global — not tied
              to a campaign — so it stays visible at every width instead of deferring to BottomNav. */}
          {context && (
            <Button size="icon-sm" variant="outline" className="hidden md:inline-flex" asChild>
              <Link to={`/codex/${context.campaignId}`} title="Codex" aria-label="Codex">
                <BookOpen className="size-4" />
              </Link>
            </Button>
          )}
          <Button size="icon-sm" variant="outline" asChild>
            <Link to="/settings" title="Settings" aria-label="Settings">
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
