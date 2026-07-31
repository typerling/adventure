import { useState } from 'react'
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom'
import { BookOpen, MapPin, Settings as SettingsIcon, Volume2, VolumeX } from 'lucide-react'
import { Toaster } from '@/components/ui/sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AuthGate } from '@/components/AuthGate'
import { Dashboard } from '@/pages/Dashboard'
import { NewCampaign } from '@/pages/NewCampaign'
import { Play } from '@/pages/Play'
import { Codex } from '@/pages/Codex'
import { Settings } from '@/pages/Settings'
import { usePlayHeaderStore } from '@/store/playHeaderStore'

function Header() {
  const context = usePlayHeaderStore((s) => s.context)
  const readAloud = usePlayHeaderStore((s) => s.readAloud)
  const toggleReadAloud = usePlayHeaderStore((s) => s.toggleReadAloud)
  const [turnInfoOpen, setTurnInfoOpen] = useState(false)

  return (
    <header className="border-b">
      <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-3">
        <div className="flex items-center gap-1.5 truncate">
          <Link to="/" className="font-semibold">
            Adventure
          </Link>
          {context && (
            <>
              <span className="text-muted-foreground">-</span>
              <Link
                to={`/play/${context.campaignId}`}
                title="Back to play"
                className="truncate font-semibold hover:text-muted-foreground"
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
          {context && (
            <Button size="icon-sm" variant="outline" asChild>
              <Link to={`/codex/${context.campaignId}`} title="Codex" aria-label="Codex">
                <BookOpen className="size-4" />
              </Link>
            </Button>
          )}
          <Button size="icon-sm" variant="outline" asChild>
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
  return (
    <div className="min-h-svh">
      <Header />
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/new" element={<NewCampaign />} />
        <Route path="/play/:campaignId" element={<Play />} />
        <Route path="/codex/:campaignId" element={<Codex />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/settings/:campaignId" element={<Settings />} />
      </Routes>
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
