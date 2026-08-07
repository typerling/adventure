import type { ReactNode } from 'react'
import { useGoogleAuth } from '@/lib/google/authStore'
import { isGoogleConfigured } from '@/lib/google/config'
import { isInstalledAndroidApp } from '@/lib/platform'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export function AuthGate({ children }: { children: ReactNode }) {
  const { status, errorMessage, signIn } = useGoogleAuth()

  if (!isGoogleConfigured) {
    return (
      <div className="flex min-h-svh items-center justify-center p-6">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Google Drive isn't configured yet</CardTitle>
            <CardDescription>
              Set <code className="rounded bg-muted px-1 py-0.5">VITE_GOOGLE_CLIENT_ID</code> in
              your <code className="rounded bg-muted px-1 py-0.5">.env</code> file to a Google
              Cloud OAuth Client ID with the Drive and Sheets APIs enabled (see DESIGN.md §12),
              then restart the dev server.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    )
  }

  if (status === 'signed-in') return <>{children}</>

  // Trying a silent reauth before showing the sign-in card — no button here, since firing an
  // interactive sign-in while this is still in flight would race the same underlying GIS request.
  if (status === 'restoring') {
    return (
      <div className="flex min-h-svh items-center justify-center p-6">
        <p className="text-sm text-muted-foreground">Reconnecting to Google Drive…</p>
      </div>
    )
  }

  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <Card className="max-w-md">
        <CardHeader>
          <CardTitle>Connect Google Drive</CardTitle>
          <CardDescription>
            Your character, story, and world data live entirely in a Google Drive folder you
            own. Sign in to create or continue an adventure.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Button onClick={() => void signIn()} disabled={status === 'signing-in'}>
            {status === 'signing-in' ? 'Connecting…' : 'Sign in with Google'}
          </Button>
          {status === 'error' && errorMessage && (
            <p className="text-sm text-destructive">{errorMessage}</p>
          )}
          {isInstalledAndroidApp() && (
            <p className="text-xs text-muted-foreground">
              Using the app installed to your home screen, you may need to sign in again every
              time you reopen it — Google's background sign-in doesn't reliably restore inside an
              installed Android app. This is a known platform limitation, not a bug in this app;
              it should now be a single tap rather than a full account picker.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
