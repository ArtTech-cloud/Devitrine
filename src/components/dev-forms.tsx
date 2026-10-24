'use client'

import { useActionState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type State = { error?: string; info?: string }
type Action = (state: State, formData: FormData) => Promise<State>

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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1 text-sm">
      <span>{label}</span>
      {children}
    </label>
  )
}

export function DevProfileForm({
  action,
  defaults,
}: {
  action: Action
  defaults?: { displayName: string; bio: string; portfolioLinks: string[] }
}) {
  const [state, formAction, pending] = useActionState(action, {})
  return (
    <form action={formAction} className="space-y-4">
      <Field label="Nome público">
        <Input name="displayName" defaultValue={defaults?.displayName} required maxLength={80} />
      </Field>
      <Field label="Bio">
        <textarea
          name="bio"
          defaultValue={defaults?.bio}
          maxLength={2000}
          rows={5}
          className="w-full rounded-md border border-border bg-background p-2 text-sm"
        />
      </Field>
      <Field label="Links de portfólio (um por linha)">
        <textarea
          name="portfolioLinks"
          defaultValue={defaults?.portfolioLinks.join('\n')}
          rows={4}
          className="w-full rounded-md border border-border bg-background p-2 text-sm"
        />
      </Field>
      <Feedback state={state} />
      <Button type="submit" disabled={pending}>
        Salvar perfil
      </Button>
    </form>
  )
}

export function KycForm({ action }: { action: Action }) {
  const [state, formAction, pending] = useActionState(action, {})
  return (
    <form action={formAction} className="space-y-4">
      <Field label="Nome completo ou razão social">
        <Input name="name" required />
      </Field>
      <Field label="CPF ou CNPJ">
        <Input name="cpfCnpj" inputMode="numeric" required />
      </Field>
      <Field label="Data de nascimento (só para CPF)">
        <Input name="birthDate" type="date" />
      </Field>
      <Field label="Tipo de empresa (só para CNPJ)">
        <select name="companyType" defaultValue="" className="w-full rounded-md border border-border bg-background p-2 text-sm">
          <option value="">—</option>
          <option value="MEI">MEI</option>
          <option value="LIMITED">Limitada</option>
          <option value="INDIVIDUAL">Empresário individual</option>
          <option value="ASSOCIATION">Associação</option>
        </select>
      </Field>
      <Field label="Celular com DDD">
        <Input name="mobilePhone" inputMode="tel" required />
      </Field>
      <Field label="CEP">
        <Input name="postalCode" inputMode="numeric" required />
      </Field>
      <Field label="Endereço">
        <Input name="address" required />
      </Field>
      <Field label="Número">
        <Input name="addressNumber" required />
      </Field>
      <Field label="Bairro">
        <Input name="province" required />
      </Field>
      <Field label="Renda ou faturamento mensal (R$)">
        <Input name="income" inputMode="decimal" placeholder="5.000,00" required />
      </Field>
      <Feedback state={state} />
      <Button type="submit" disabled={pending}>
        Iniciar verificação
      </Button>
    </form>
  )
}

export function ActionButton({ action, label }: { action: (s: State) => Promise<State>; label: string }) {
  const [state, formAction, pending] = useActionState(action, {})
  return (
    <form action={formAction} className="space-y-2">
      <Button type="submit" variant="outline" disabled={pending}>
        {label}
      </Button>
      <Feedback state={state} />
    </form>
  )
}

export function DecisionForm({
  action,
  devId,
  options,
}: {
  action: Action
  devId: string
  options: { status: 'approved' | 'suspended'; label: string }[]
}) {
  const [state, formAction, pending] = useActionState(action, {})
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="devId" value={devId} />
      <Input name="reason" placeholder="Motivo (opcional)" maxLength={500} className="w-56" />
      {options.map((o) => (
        <Button key={o.status} type="submit" name="status" value={o.status} variant="outline" disabled={pending}>
          {o.label}
        </Button>
      ))}
      <Feedback state={state} />
    </form>
  )
}
