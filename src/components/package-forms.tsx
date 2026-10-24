'use client'

import { useActionState, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { feeCents, formatBRL, parseBRL } from '@/lib/money'

type State = { error?: string; info?: string; fieldErrors?: Record<string, string> }
type Action = (state: State, formData: FormData) => Promise<State>

const TIER_FIELDS = [
  { tier: 'basic', label: 'Básico', required: true },
  { tier: 'standard', label: 'Padrão', required: false },
  { tier: 'premium', label: 'Premium', required: false },
] as const

export interface TierDefaults {
  price: string
  days: string
  revisions: string
  scope: string
}

export interface PackageDefaults {
  packageId?: string
  categoryId: string
  title: string
  summary: string
  descriptionMd: string
  tiers: Partial<Record<'basic' | 'standard' | 'premium', TierDefaults>>
}

function Feedback({ state }: { state: State }) {
  return (
    <>
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      {state.info && (
        <p role="status" className="text-sm text-success">
          {state.info}
        </p>
      )}
    </>
  )
}

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1 text-sm">
      <span>{label}</span>
      {children}
      {error && <span className="block text-destructive">{error}</span>}
    </label>
  )
}

const textarea = 'w-full rounded-md border border-border bg-background p-2 text-sm'

function Net({ price, feeBps }: { price: string; feeBps: number }) {
  const cents = parseBRL(price)
  if (cents === null || cents <= 0n) return null
  const fee = feeCents(cents, feeBps)
  return (
    <p className="text-xs text-muted-foreground">
      Taxa da plataforma (1ª venda) {formatBRL(fee)} · você recebe {formatBRL(cents - fee)}
    </p>
  )
}

function TierFields({
  tier,
  label,
  required,
  defaults,
  feeBps,
  errors,
}: {
  tier: string
  label: string
  required: boolean
  defaults?: TierDefaults
  feeBps: number
  errors?: Record<string, string>
}) {
  const [price, setPrice] = useState(defaults?.price ?? '')
  return (
    <fieldset className="space-y-3 rounded-md border border-border p-4" data-testid={`tier-${tier}`}>
      <legend className="px-1 text-sm font-medium">
        {label}
        {required ? '' : ' (opcional)'}
      </legend>
      <Field label="Preço (R$)" error={errors?.[`${tier}_price`]}>
        <Input
          name={`${tier}_price`}
          inputMode="decimal"
          placeholder="500,00"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
        />
      </Field>
      <Net price={price} feeBps={feeBps} />
      <Field label="Prazo (dias)" error={errors?.[`${tier}_days`]}>
        <Input name={`${tier}_days`} inputMode="numeric" defaultValue={defaults?.days} />
      </Field>
      <Field label="Revisões incluídas" error={errors?.[`${tier}_revisions`]}>
        <Input name={`${tier}_revisions`} inputMode="numeric" defaultValue={defaults?.revisions ?? '1'} />
      </Field>
      <Field label="O que está incluso" error={errors?.[`${tier}_scope`]}>
        <textarea name={`${tier}_scope`} rows={4} defaultValue={defaults?.scope} className={textarea} />
      </Field>
    </fieldset>
  )
}

export function PackageForm({
  action,
  categories,
  defaults,
  feeBps,
  submitLabel,
}: {
  action: Action
  categories: { id: string; name: string }[]
  defaults?: PackageDefaults
  feeBps: number
  submitLabel: string
}) {
  const [state, formAction, pending] = useActionState(action, {})
  const errors = state.fieldErrors
  return (
    <form action={formAction} className="space-y-4">
      {defaults?.packageId && <input type="hidden" name="packageId" value={defaults.packageId} />}
      <Field label="Categoria" error={errors?.categoryId}>
        <select
          name="categoryId"
          defaultValue={defaults?.categoryId ?? ''}
          required
          className="w-full rounded-md border border-border bg-background p-2 text-sm"
        >
          <option value="" disabled>
            Escolha…
          </option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Título" error={errors?.title}>
        <Input name="title" defaultValue={defaults?.title} required minLength={5} maxLength={80} />
      </Field>
      <Field label="Resumo (aparece na vitrine)" error={errors?.summary}>
        <Input name="summary" defaultValue={defaults?.summary} required minLength={10} maxLength={160} />
      </Field>
      <Field label="Descrição" error={errors?.descriptionMd}>
        <textarea name="descriptionMd" rows={8} maxLength={10000} defaultValue={defaults?.descriptionMd} className={textarea} />
      </Field>
      {TIER_FIELDS.map((t) => (
        <TierFields
          key={t.tier}
          tier={t.tier}
          label={t.label}
          required={t.required}
          defaults={defaults?.tiers[t.tier]}
          feeBps={feeBps}
          errors={errors}
        />
      ))}
      <Feedback state={state} />
      <Button type="submit" disabled={pending}>
        {submitLabel}
      </Button>
    </form>
  )
}

export function PackageActionButton({
  action,
  packageId,
  label,
  variant = 'outline',
}: {
  action: Action
  packageId: string
  label: string
  variant?: 'outline' | 'default'
}) {
  const [state, formAction, pending] = useActionState(action, {})
  return (
    <form action={formAction} className="space-y-1">
      <input type="hidden" name="packageId" value={packageId} />
      <Button type="submit" variant={variant} disabled={pending}>
        {label}
      </Button>
      <Feedback state={state} />
    </form>
  )
}

export function PackageDecisionForm({
  approve,
  reject,
  packageId,
}: {
  approve: Action
  reject: Action
  packageId: string
}) {
  const [approveState, approveAction, approving] = useActionState(approve, {})
  const [rejectState, rejectAction, rejecting] = useActionState(reject, {})
  return (
    <div className="space-y-2">
      <form action={approveAction} className="inline">
        <input type="hidden" name="packageId" value={packageId} />
        <Button type="submit" variant="outline" disabled={approving}>
          Publicar
        </Button>
      </form>
      <Feedback state={approveState} />
      <form action={rejectAction} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="packageId" value={packageId} />
        <Input name="reason" placeholder="Motivo da devolução" required minLength={3} maxLength={500} className="w-64" />
        <Button type="submit" variant="outline" disabled={rejecting}>
          Devolver ao dev
        </Button>
      </form>
      <Feedback state={rejectState} />
    </div>
  )
}
