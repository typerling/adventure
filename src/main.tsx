import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ensureCrossOriginIsolated } from './lib/coiServiceWorker'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Fire-and-forget: see src/lib/coiServiceWorker.ts. Runs after the initial render rather than
// blocking it - the (rare) reload this can trigger just repeats the same render a moment later.
void ensureCrossOriginIsolated()
