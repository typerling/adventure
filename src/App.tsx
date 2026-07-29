import { BrowserRouter, Link, Route, Routes } from 'react-router-dom'
import { Toaster } from '@/components/ui/sonner'
import { AuthGate } from '@/components/AuthGate'
import { Dashboard } from '@/pages/Dashboard'
import { NewCampaign } from '@/pages/NewCampaign'
import { Play } from '@/pages/Play'
import { Codex } from '@/pages/Codex'
import { Settings } from '@/pages/Settings'

function AppShell() {
  return (
    <div className="min-h-svh">
      <header className="border-b">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-3">
          <Link to="/" className="font-semibold">
            AI Adventure
          </Link>
          <Link to="/settings" className="text-sm text-muted-foreground hover:text-foreground">
            Settings
          </Link>
        </div>
      </header>
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
    <BrowserRouter>
      <AuthGate>
        <AppShell />
      </AuthGate>
      <Toaster />
    </BrowserRouter>
  )
}

export default App
