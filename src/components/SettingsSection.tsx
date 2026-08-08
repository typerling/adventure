import type { ReactNode } from 'react'

export interface SettingsSectionProps {
  title: string
  description?: ReactNode
  children: ReactNode
  className?: string
}

/**
 * A headed group of Settings cards (issue #22's restructure: "This campaign" / "AI & voice
 * providers" / "Account"). Purely presentational — it groups and labels whatever cards are passed
 * as children, with no opinion on their own internal layout/gating logic. Kept as its own small
 * component (rather than inlined divs repeated three times in Settings.tsx) so it has one place to
 * adjust heading style and one Storybook story covering it in isolation, per the epic's working
 * agreement on Storybook coverage for restructured/new settings components.
 */
export function SettingsSection({ title, description, children, className }: SettingsSectionProps) {
  return (
    <section className={className} aria-labelledby={`settings-section-${slugify(title)}`}>
      <div className="mb-3 flex flex-col gap-1">
        <h2
          id={`settings-section-${slugify(title)}`}
          className="font-heading text-lg font-medium text-foreground"
        >
          {title}
        </h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  )
}

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
}
