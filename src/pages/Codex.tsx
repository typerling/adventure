import { useEffect } from 'react'
import { useParams } from 'react-router'
import { CircleAlert, Loader2 } from 'lucide-react'
import { useCampaign } from '@/hooks/useCampaign'
import { usePlayHeaderStore } from '@/store/playHeaderStore'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ScrollArea } from '@/components/ui/scroll-area'

export function Codex() {
  const { campaignId } = useParams<{ campaignId: string }>()
  const { status, errorMessage, campaign, snapshot } = useCampaign(campaignId)
  const setHeaderContext = usePlayHeaderStore((s) => s.setContext)
  const campaignName = campaign?.meta.name

  // See Play.tsx for why this goes through a shared store rather than props/context.
  useEffect(() => {
    if (!campaignId || !campaignName) return
    setHeaderContext({ campaignId, campaignName, showReadAloudToggle: false, turnLabel: null })
    return () => setHeaderContext(null)
  }, [campaignId, campaignName, setHeaderContext])

  if (status === 'loading') {
    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center gap-3 px-6 text-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Loading codex…</p>
      </div>
    )
  }
  if (status === 'error' || !campaign || !snapshot) {
    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center gap-3 px-6 text-center">
        <CircleAlert className="size-6 text-destructive" />
        <p className="max-w-sm text-sm text-destructive">Couldn't load this campaign: {errorMessage}</p>
      </div>
    )
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6 sm:px-6 sm:py-8">
      <h1 className="font-heading text-2xl font-medium text-foreground">Codex</h1>

      <Tabs defaultValue="character">
        <TabsList className="w-full justify-start overflow-x-auto">
          <TabsTrigger value="character">Character</TabsTrigger>
          <TabsTrigger value="inventory">Inventory</TabsTrigger>
          <TabsTrigger value="skills">Skills</TabsTrigger>
          <TabsTrigger value="npcs">NPCs</TabsTrigger>
          <TabsTrigger value="monsters">Monsters</TabsTrigger>
          <TabsTrigger value="quests">Quests</TabsTrigger>
          <TabsTrigger value="map">Map</TabsTrigger>
          <TabsTrigger value="lore">Lore</TabsTrigger>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
        </TabsList>

        <TabsContent value="character">
          <ScrollArea className="h-[60vh]">
            <div className="flex flex-col gap-2">
              {snapshot.Character.map((c, i) => (
                <div key={i} className="flex justify-between rounded-md border px-3 py-2 text-sm">
                  <span className="font-medium">{c.key}</span>
                  <span className="text-muted-foreground">{c.value}</span>
                </div>
              ))}
              {snapshot.Character.length === 0 && <Empty label="No stats recorded yet." />}
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="inventory">
          <ScrollArea className="h-[60vh]">
            <div className="flex flex-col gap-2">
              {snapshot.Inventory.filter((i) => i.active).map((item) => (
                <Card key={item.id}>
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center justify-between text-sm">
                      <span>{item.name}</span>
                      <Badge variant="secondary">x{item.qty}</Badge>
                    </CardTitle>
                  </CardHeader>
                  {item.description && (
                    <CardContent className="pt-0 text-sm text-muted-foreground">{item.description}</CardContent>
                  )}
                </Card>
              ))}
              {snapshot.Inventory.filter((i) => i.active).length === 0 && <Empty label="Inventory is empty." />}
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="skills">
          <ScrollArea className="h-[60vh]">
            <div className="flex flex-col gap-2">
              {snapshot.Skills.map((s) => (
                <div key={s.id} className="rounded-md border px-3 py-2 text-sm">
                  <div className="flex justify-between">
                    <span className="font-medium">{s.name}</span>
                    <Badge variant="outline">{s.rank}</Badge>
                  </div>
                  {s.description && <p className="mt-1 text-muted-foreground">{s.description}</p>}
                </div>
              ))}
              {snapshot.Skills.length === 0 && <Empty label="No skills recorded yet." />}
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="npcs">
          <ScrollArea className="h-[60vh]">
            <div className="flex flex-col gap-2">
              {snapshot.NPCs.map((n) => (
                <div key={n.id} className="rounded-md border px-3 py-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{n.name}</span>
                    <Badge variant={n.status === 'dead' ? 'destructive' : 'secondary'}>{n.status}</Badge>
                  </div>
                  {n.relationship && <p className="text-xs text-muted-foreground">{n.relationship}</p>}
                  {n.description && <p className="mt-1 text-muted-foreground">{n.description}</p>}
                </div>
              ))}
              {snapshot.NPCs.length === 0 && <Empty label="No NPCs met yet." />}
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="monsters">
          <ScrollArea className="h-[60vh]">
            <div className="flex flex-col gap-2">
              {snapshot.Monsters.map((m) => (
                <div key={m.id} className="rounded-md border px-3 py-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{m.name}</span>
                    <Badge variant={m.status === 'dead' ? 'destructive' : 'secondary'}>{m.status}</Badge>
                  </div>
                  {m.description && <p className="mt-1 text-muted-foreground">{m.description}</p>}
                  {m.threatNotes && <p className="text-xs text-muted-foreground">Threat: {m.threatNotes}</p>}
                </div>
              ))}
              {snapshot.Monsters.length === 0 && <Empty label="No creatures encountered yet." />}
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="quests">
          <ScrollArea className="h-[60vh]">
            <div className="flex flex-col gap-2">
              {snapshot.Quests.map((q) => (
                <div key={q.id} className="rounded-md border px-3 py-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{q.title}</span>
                    <Badge variant={q.status === 'completed' ? 'secondary' : q.status === 'failed' ? 'destructive' : 'outline'}>
                      {q.status}
                    </Badge>
                  </div>
                  {q.description && <p className="mt-1 text-muted-foreground">{q.description}</p>}
                </div>
              ))}
              {snapshot.Quests.length === 0 && <Empty label="No quests yet." />}
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="map">
          <ScrollArea className="h-[60vh]">
            <div className="flex flex-col gap-2">
              <p className="text-xs text-muted-foreground">
                Graph view is a Phase 2 feature (DESIGN.md §11) — listed here for now.
              </p>
              {snapshot.Map.map((node) => (
                <div key={node.id} className="rounded-md border px-3 py-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{node.name}</span>
                    <Badge variant="outline">{node.state}</Badge>
                  </div>
                  {node.connectsTo && <p className="text-xs text-muted-foreground">Connects to: {node.connectsTo}</p>}
                  {node.description && <p className="mt-1 text-muted-foreground">{node.description}</p>}
                </div>
              ))}
              {snapshot.Map.length === 0 && <Empty label="No locations discovered yet." />}
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="lore">
          <ScrollArea className="h-[60vh]">
            <div className="flex flex-col gap-2">
              {snapshot.Lore.filter((l) => l.discovered).map((l) => (
                <div key={l.id} className="rounded-md border px-3 py-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{l.name}</span>
                    <Badge variant="outline">{l.type}</Badge>
                  </div>
                  <p className="mt-1 text-muted-foreground">{l.summary}</p>
                </div>
              ))}
              {snapshot.Lore.filter((l) => l.discovered).length === 0 && <Empty label="No lore uncovered yet." />}
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="timeline">
          <ScrollArea className="h-[60vh]">
            <div className="flex flex-col gap-2">
              {snapshot.Timeline.slice()
                .reverse()
                .map((e, i) => (
                  <div key={i} className="rounded-md border px-3 py-2 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{e.title}</span>
                      <Badge variant="outline">Turn {e.turn}</Badge>
                    </div>
                    {e.summary && <p className="mt-1 text-muted-foreground">{e.summary}</p>}
                  </div>
                ))}
              {snapshot.Timeline.length === 0 && <Empty label="Nothing has happened yet." />}
            </div>
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </div>
  )
}

function Empty({ label }: { label: string }) {
  return <p className="p-4 text-sm text-muted-foreground">{label}</p>
}
