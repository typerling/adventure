import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { useLibrary } from '@/store/libraryStore'
import { DIFFICULTIES, type Difficulty } from '@/types/campaign'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Progress } from '@/components/ui/progress'
import { Trash2, Sparkles, Dice5, X } from 'lucide-react'
import {
  SUGGESTED_THEMES,
  generateFullCampaign,
  generateName,
  generateWorldPrompt,
  generateStartingLocation,
  generateHouseRules,
  generateStats,
  generateInventory,
  randomTheme,
} from '@/lib/random/campaignGenerator'

interface CharacterStatDraft {
  key: string
  value: string
}
interface InventoryDraft {
  name: string
  qty: number
  description: string
  tags: string
}

const THEME_DATALIST_ID = 'theme-suggestions'

/** Small icon-only button used throughout the wizard to auto-fill one field. */
function GenerateButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <Button type="button" variant="outline" size="icon" title={label} aria-label={label} onClick={onClick}>
      <Sparkles className="size-4" />
    </Button>
  )
}

const STEPS = ['Basics', 'Character', 'Inventory', 'World & expectations', 'Review'] as const

export function NewCampaign() {
  const navigate = useNavigate()
  const { createCampaign } = useLibrary()
  const [step, setStep] = useState(0)
  const [submitting, setSubmitting] = useState(false)

  const [name, setName] = useState('')
  const [genre, setGenre] = useState('')
  const [difficulty, setDifficulty] = useState<Difficulty>('Standard')

  const [stats, setStats] = useState<CharacterStatDraft[]>([
    { key: 'Name', value: '' },
    { key: 'Description', value: '' },
    { key: 'HP', value: '20' },
  ])

  const [inventory, setInventory] = useState<InventoryDraft[]>([
    { name: '', qty: 1, description: '', tags: '' },
  ])

  const [worldPrompt, setWorldPrompt] = useState('')
  const [startingLocation, setStartingLocation] = useState('')
  const [houseRules, setHouseRules] = useState('')

  const canGoNext = (() => {
    if (step === 0) return name.trim().length > 0
    if (step === 3) return worldPrompt.trim().length > 0 && startingLocation.trim().length > 0
    return true
  })()

  function handleRandomizeAll() {
    const generated = generateFullCampaign()
    setName(generated.name)
    setGenre(generated.genre)
    setWorldPrompt(generated.worldPrompt)
    setStartingLocation(generated.startingLocation)
    setHouseRules(generated.houseRules)
    setStats(generated.stats)
    setInventory(generated.inventory)
    toast.success('Randomized a starting point — tweak anything before creating.')
  }

  async function handleCreate() {
    setSubmitting(true)
    try {
      const created = await createCampaign({
        name: name.trim(),
        genre: genre.trim(),
        difficulty,
        houseRules: houseRules.trim() || undefined,
        worldPrompt: worldPrompt.trim(),
        startingLocation: startingLocation.trim(),
        character: stats.filter((s) => s.key.trim()),
        inventory: inventory.filter((i) => i.name.trim()),
      })
      toast.success(`${created.name} is ready.`)
      navigate(`/play/${created.folderId}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">New campaign</h1>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={handleRandomizeAll}>
            <Dice5 className="size-4" />
            Random campaign
          </Button>
          <Button asChild variant="ghost" size="icon" title="Cancel and return to dashboard" aria-label="Cancel and return to dashboard">
            <Link to="/">
              <X className="size-4" />
            </Link>
          </Button>
        </div>
      </div>
      <p className="mb-4 text-sm text-muted-foreground">{STEPS[step]}</p>
      <Progress value={((step + 1) / STEPS.length) * 100} className="mb-6" />

      {step === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>The basics</CardTitle>
            <CardDescription>What is this adventure, broadly?</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="name">Campaign name</Label>
              <div className="flex gap-2">
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="The Sunken Chapel"
                />
                <GenerateButton label="Generate a name" onClick={() => setName(generateName(genre))} />
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="genre">Genre / theme</Label>
              <div className="flex gap-2">
                <Input
                  id="genre"
                  value={genre}
                  onChange={(e) => setGenre(e.target.value)}
                  placeholder="Cozy fantasy, cyberpunk heist, horror survival…"
                  list={THEME_DATALIST_ID}
                />
                <datalist id={THEME_DATALIST_ID}>
                  {SUGGESTED_THEMES.map((t) => (
                    <option key={t} value={t} />
                  ))}
                </datalist>
                <GenerateButton label="Pick a random theme" onClick={() => setGenre(randomTheme())} />
              </div>
              <p className="text-xs text-muted-foreground">
                Start typing to see suggested themes, or write your own — genre is free text.
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <Label>Difficulty</Label>
              <Select value={difficulty} onValueChange={(v) => setDifficulty(v as Difficulty)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DIFFICULTIES.map((d) => (
                    <SelectItem key={d} value={d}>
                      {d}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 1 && (
        <Card>
          <CardHeader>
            <CardTitle>Your character</CardTitle>
            <CardDescription>
              Free-form stats — add whatever fits your world (HP, Charm, Reputation, Sanity…).
              Optional — skip this and add stats later from the Codex.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {stats.map((s, i) => (
              <div key={i} className="flex gap-2">
                <Input
                  placeholder="Stat"
                  value={s.key}
                  onChange={(e) =>
                    setStats((arr) => arr.map((r, ri) => (ri === i ? { ...r, key: e.target.value } : r)))
                  }
                  className="w-1/3"
                />
                <Input
                  placeholder="Value"
                  value={s.value}
                  onChange={(e) =>
                    setStats((arr) => arr.map((r, ri) => (ri === i ? { ...r, value: e.target.value } : r)))
                  }
                />
                <Button
                  variant="ghost"
                  size="icon"
                  title="Remove stat"
                  aria-label="Remove stat"
                  onClick={() => setStats((arr) => arr.filter((_, ri) => ri !== i))}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setStats((arr) => [...arr, { key: '', value: '' }])}>
                Add stat
              </Button>
              <Button variant="outline" size="sm" onClick={() => setStats(generateStats(genre))}>
                <Sparkles className="size-4" />
                Generate stats
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 2 && (
        <Card>
          <CardHeader>
            <CardTitle>Starting inventory</CardTitle>
            <CardDescription>
              What are you carrying when the story begins? Optional — skip this if you'd rather
              start with nothing.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {inventory.map((item, i) => (
              <div key={i} className="flex flex-col gap-2 rounded-md border p-3">
                <div className="flex gap-2">
                  <Input
                    placeholder="Item name"
                    value={item.name}
                    onChange={(e) =>
                      setInventory((arr) => arr.map((r, ri) => (ri === i ? { ...r, name: e.target.value } : r)))
                    }
                  />
                  <Input
                    type="number"
                    min={1}
                    className="w-20"
                    value={item.qty}
                    onChange={(e) =>
                      setInventory((arr) =>
                        arr.map((r, ri) =>
                          ri === i ? { ...r, qty: Math.max(1, Number(e.target.value) || 1) } : r,
                        ),
                      )
                    }
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    title="Remove item"
                    aria-label="Remove item"
                    onClick={() => setInventory((arr) => arr.filter((_, ri) => ri !== i))}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
                <Input
                  placeholder="Description (optional)"
                  value={item.description}
                  onChange={(e) =>
                    setInventory((arr) =>
                      arr.map((r, ri) => (ri === i ? { ...r, description: e.target.value } : r)),
                    )
                  }
                />
              </div>
            ))}
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setInventory((arr) => [...arr, { name: '', qty: 1, description: '', tags: '' }])}
              >
                Add item
              </Button>
              <Button variant="outline" size="sm" onClick={() => setInventory(generateInventory(genre))}>
                <Sparkles className="size-4" />
                Generate items
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 3 && (
        <Card>
          <CardHeader>
            <CardTitle>World, scenario & expectations</CardTitle>
            <CardDescription>
              This becomes the DM's brief for every turn — be as detailed as you like.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="world">World & scenario</Label>
                <GenerateButton
                  label="Generate world & scenario"
                  onClick={() => setWorldPrompt(generateWorldPrompt(genre))}
                />
              </div>
              <Textarea
                id="world"
                rows={8}
                value={worldPrompt}
                onChange={(e) => setWorldPrompt(e.target.value)}
                placeholder="Describe the setting, the opening situation, tone, and what you expect/want from the story (e.g. 'political intrigue over combat', 'keep it lighthearted', 'I want real consequences for failure')…"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="location">Starting location</Label>
              <div className="flex gap-2">
                <Input
                  id="location"
                  value={startingLocation}
                  onChange={(e) => setStartingLocation(e.target.value)}
                  placeholder="The docks of Kelmouth"
                />
                <GenerateButton
                  label="Generate starting location"
                  onClick={() => setStartingLocation(generateStartingLocation(genre))}
                />
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="rules">House rules (optional)</Label>
                <GenerateButton
                  label="Generate house rules"
                  onClick={() => setHouseRules(generateHouseRules(genre))}
                />
              </div>
              <Textarea
                id="rules"
                rows={3}
                value={houseRules}
                onChange={(e) => setHouseRules(e.target.value)}
                placeholder="Any specific resolution mechanic, tone rules, or hard limits."
              />
            </div>
          </CardContent>
        </Card>
      )}

      {step === 4 && (
        <Card>
          <CardHeader>
            <CardTitle>Review</CardTitle>
            <CardDescription>This creates the campaign folder and spreadsheet in Drive.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            <p>
              <span className="font-medium">{name}</span> — {genre || 'unspecified genre'} — {difficulty}
            </p>
            <p className="text-muted-foreground">{stats.filter((s) => s.key.trim()).length} stat(s), {inventory.filter((i) => i.name.trim()).length} item(s)</p>
            <p className="text-muted-foreground">Starting location: {startingLocation}</p>
          </CardContent>
        </Card>
      )}

      <div className="mt-6 flex justify-between">
        <Button variant="outline" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>
          Back
        </Button>
        {step < STEPS.length - 1 ? (
          <Button onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))} disabled={!canGoNext}>
            Next
          </Button>
        ) : (
          <Button onClick={() => void handleCreate()} disabled={submitting}>
            {submitting ? 'Creating…' : 'Create campaign'}
          </Button>
        )}
      </div>
    </div>
  )
}
