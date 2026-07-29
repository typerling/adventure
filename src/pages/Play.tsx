import { useMemo, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { toast } from 'sonner'
import { useCampaign } from '@/hooks/useCampaign'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { ValidationIssue } from '@/types/turn'

type DialogStage = 'closed' | 'prompt' | 'error'

export function Play() {
  const { campaignId } = useParams<{ campaignId: string }>()
  const data = useCampaign(campaignId)
  const { status, errorMessage, campaign, snapshot, recentTurns, buildPromptForAction, submitReply } = data

  const [freeText, setFreeText] = useState('')
  const [pendingAction, setPendingAction] = useState('')
  const [prompt, setPrompt] = useState('')
  const [reply, setReply] = useState('')
  const [stage, setStage] = useState<DialogStage>('closed')
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [issues, setIssues] = useState<ValidationIssue[]>([])
  const [submitting, setSubmitting] = useState(false)

  const lastTurn = recentTurns.at(-1)
  const options = lastTurn?.optionsOffered ?? []

  const hpValue = useMemo(
    () => snapshot?.Character.find((c) => c.key.trim().toLowerCase() === 'hp')?.value,
    [snapshot],
  )

  function startTurn(action: string) {
    const built = buildPromptForAction(action)
    if (!built) return
    setPendingAction(action)
    setPrompt(built)
    setReply('')
    setDialogError(null)
    setIssues([])
    setStage('prompt')
  }

  async function copyPrompt() {
    await navigator.clipboard.writeText(prompt)
    toast.success('Prompt copied — paste it into claude.ai or chatgpt.com')
  }

  async function handleSubmitReply() {
    setSubmitting(true)
    setDialogError(null)
    setIssues([])
    try {
      const outcome = await submitReply(pendingAction, reply)
      if (outcome.ok) {
        setStage('closed')
        setFreeText('')
        toast.success('Turn applied.')
        return
      }
      if ('issues' in outcome) {
        setIssues(outcome.issues)
      } else {
        setDialogError(outcome.error)
      }
    } finally {
      setSubmitting(false)
    }
  }

  function copyCorrectionPrompt() {
    const issueList = issues.map((i) => `- ${i.message}`).join('\n')
    const correction = `${prompt}\n\nYour previous reply had these problems — fix them and resend the FULL reply (narrative + \`\`\`state block) in the exact same format:\n${issueList}`
    void navigator.clipboard.writeText(correction)
    toast.success('Correction prompt copied.')
  }

  if (status === 'loading') {
    return <div className="p-10 text-sm text-muted-foreground">Loading campaign…</div>
  }
  if (status === 'error' || !campaign || !snapshot) {
    return (
      <div className="p-10 text-sm text-destructive">
        Couldn't load this campaign: {errorMessage}
        <div className="mt-4">
          <Button asChild variant="outline">
            <Link to="/">Back to dashboard</Link>
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{campaign.meta.name}</h1>
          <p className="text-sm text-muted-foreground">
            Turn {campaign.meta.currentTurn} · {campaign.meta.currentLocation}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {hpValue !== undefined && <Badge variant="outline">HP {hpValue}</Badge>}
          <Badge variant="secondary">{campaign.meta.difficulty}</Badge>
          <Button asChild size="sm" variant="outline">
            <Link to={`/codex/${campaignId}`}>Codex</Link>
          </Button>
        </div>
      </div>

      <Separator />

      <ScrollArea className="h-[50vh] rounded-md border p-4">
        {recentTurns.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No story yet — describe your first action below to begin.
          </p>
        ) : (
          <div className="flex flex-col gap-6">
            {recentTurns.map((t) => (
              <div key={t.turn} className="flex flex-col gap-2">
                <p className="text-sm font-medium text-muted-foreground">
                  Turn {t.turn} — you: {t.playerAction}
                </p>
                <p className="whitespace-pre-wrap text-sm leading-relaxed">{t.narrative}</p>
              </div>
            ))}
          </div>
        )}
      </ScrollArea>

      {options.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {options.map((opt) => (
            <Button key={opt} variant="outline" size="sm" onClick={() => startTurn(opt)}>
              {opt}
            </Button>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <Textarea
          value={freeText}
          onChange={(e) => setFreeText(e.target.value)}
          placeholder="Say or do anything…"
          rows={2}
          className="flex-1"
        />
        <Button onClick={() => startTurn(freeText)} disabled={!freeText.trim()}>
          Act
        </Button>
      </div>

      <Dialog open={stage !== 'closed'} onOpenChange={(open) => !open && setStage('closed')}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Manual DM turn</DialogTitle>
            <DialogDescription>
              Copy this prompt into claude.ai or chatgpt.com, then paste the reply back here.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">1. Prompt</p>
              <Button size="sm" variant="outline" onClick={() => void copyPrompt()}>
                Copy prompt
              </Button>
            </div>
            <Textarea readOnly value={prompt} rows={8} className="font-mono text-xs" />

            <p className="text-sm font-medium">2. Paste the AI's full reply</p>
            <Textarea
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              rows={8}
              placeholder="Paste the narrative + trailing ```state block here…"
              className="font-mono text-xs"
            />

            {dialogError && <p className="text-sm text-destructive">{dialogError}</p>}

            {issues.length > 0 && (
              <div className="rounded-md border border-destructive/50 p-3">
                <p className="mb-2 text-sm font-medium text-destructive">
                  This reply doesn't match the documented state:
                </p>
                <ul className="mb-3 list-inside list-disc text-sm">
                  {issues.map((i, idx) => (
                    <li key={idx} className={i.severity === 'error' ? 'text-destructive' : 'text-muted-foreground'}>
                      {i.message}
                    </li>
                  ))}
                </ul>
                {issues.some((i) => i.severity === 'error') && (
                  <Button size="sm" variant="outline" onClick={copyCorrectionPrompt}>
                    Copy correction prompt
                  </Button>
                )}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setStage('closed')}>
              Cancel
            </Button>
            <Button onClick={() => void handleSubmitReply()} disabled={!reply.trim() || submitting}>
              {submitting ? 'Applying…' : 'Apply turn'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
