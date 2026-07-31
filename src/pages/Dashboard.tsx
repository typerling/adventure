import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Settings as SettingsIcon } from 'lucide-react'
import { useLibrary } from '@/store/libraryStore'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

export function Dashboard() {
  const { status, errorMessage, campaigns, load } = useLibrary()

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Your adventures</h1>
          <p className="text-sm text-muted-foreground">
            Stored in the "Adventure" folder in your Google Drive.
          </p>
        </div>
        <Button asChild>
          <Link to="/new">New campaign</Link>
        </Button>
      </div>

      {status === 'loading' && <p className="text-sm text-muted-foreground">Loading your library…</p>}

      {status === 'error' && (
        <p className="text-sm text-destructive">Couldn't load your library: {errorMessage}</p>
      )}

      {status === 'ready' && campaigns.length === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>No campaigns yet</CardTitle>
            <CardDescription>Start your first adventure to get going.</CardDescription>
          </CardHeader>
          <CardFooter>
            <Button asChild>
              <Link to="/new">Create your first campaign</Link>
            </Button>
          </CardFooter>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {campaigns.map((c) => (
          <Card key={c.folderId}>
            <CardHeader>
              <CardTitle className="flex items-center justify-between gap-2">
                <span>{c.name}</span>
                {c.difficulty !== 'Standard' && <Badge variant="secondary">{c.difficulty}</Badge>}
              </CardTitle>
              <CardDescription>Turn {c.currentTurn}</CardDescription>
            </CardHeader>
            <CardFooter className="flex gap-2">
              <Button asChild size="sm">
                <Link to={`/play/${c.folderId}`}>Continue</Link>
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link to={`/codex/${c.folderId}`}>Codex</Link>
              </Button>
              <Button asChild size="sm" variant="outline" title="Campaign settings" aria-label="Campaign settings">
                <Link to={`/settings/${c.folderId}`}>
                  <SettingsIcon className="size-4" />
                </Link>
              </Button>
            </CardFooter>
          </Card>
        ))}
      </div>
    </div>
  )
}
