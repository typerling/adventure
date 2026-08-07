import { BrowserRouter, Route, Routes } from 'react-router'
import { Toaster } from '@/components/ui/sonner'
import { AuthGate } from '@/components/AuthGate'
import { Header } from '@/components/Header'
import { Dashboard } from '@/pages/Dashboard'
import { NewCampaign } from '@/pages/NewCampaign'
import { Play } from '@/pages/Play'
import { Codex } from '@/pages/Codex'
import { Settings } from '@/pages/Settings'

function AppShell() {
  return (
    <div className="min-h-svh">
      <Header />
      <div data-testid="app-content">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/new" element={<NewCampaign />} />
          <Route path="/play/:campaignId" element={<Play />} />
          <Route path="/codex/:campaignId" element={<Codex />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/settings/:campaignId" element={<Settings />} />
        </Routes>
      </div>
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
