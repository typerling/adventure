import { useState } from 'react'
import { Link } from 'react-router-dom'
import { BookOpen, Home, MapPin, Menu, Settings as SettingsIcon, Volume2, VolumeX } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { usePlayHeaderStore } from '@/store/playHeaderStore'

/**
 * The app's persistent top bar. This is the header's *only* nav treatment now, at every viewport
 * width — there used to be two parallel systems (this header's Codex/Settings icons, visible only
 * `md:` and up, plus a separate `BottomNav` tab bar covering mobile below that breakpoint); both
 * are gone in favor of one hamburger dropdown that works the same way everywhere. See
 * https://github.com/typerling/adventure/issues/21 for the scoping discussion that settled this.
 *
 * Only pure navigation lives in the dropdown (Codex, Settings, "Back to campaigns") — it's sparse
 * (Settings only) when no campaign context is registered (Dashboard/NewCampaign), and gains
 * Codex/Back-to-campaigns once one is (Play/Codex/Settings, via usePlayHeaderStore). The
 * read-aloud toggle and the turn/location info button stay as their own standalone icons next to
 * the trigger, not folded into the menu — both get used repeatedly mid-session, unlike the menu's
 * one-shot navigation actions.
 */
export function Header() {
  const context = usePlayHeaderStore((s) => s.context)
  const readAloud = usePlayHeaderStore((s) => s.readAloud)
  const toggleReadAloud = usePlayHeaderStore((s) => s.toggleReadAloud)
  const [turnInfoOpen, setTurnInfoOpen] = useState(false)

  return (
    <header className="border-b border-border/70 bg-card/60">
      <div className="mx-auto flex max-w-3xl items-center justify-between gap-2 px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-1.5 truncate">
          {context ? (
            <>
              {/* Logo-only once a campaign name is showing — "Adventure - <name>" rarely both fit
                  next to each other, and the campaign name is the more useful thing to keep. The
                  dropdown's "Back to campaigns" item is the labeled equivalent of this link. */}
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="outline" title="Menu" aria-label="Menu">
                <Menu className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            {/* min-w-52 overrides the primitive's min-w-32 default — this trigger is a small
                icon-only button, so the shared floor left "Back to campaigns" wrapping to two
                lines at phone width (flagged in PR #34 review); measured empirically, 160px
                still wrapped, 208px doesn't. */}
            <DropdownMenuContent align="end" className="min-w-52">
              {context && (
                <DropdownMenuItem asChild>
                  <Link to={`/codex/${context.campaignId}`}>
                    <BookOpen className="size-4" />
                    Codex
                  </Link>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem asChild>
                <Link to={context ? `/settings/${context.campaignId}` : '/settings'}>
                  <SettingsIcon className="size-4" />
                  Settings
                </Link>
              </DropdownMenuItem>
              {context && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild>
                    <Link to="/">
                      <Home className="size-4" />
                      Back to campaigns
                    </Link>
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
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
