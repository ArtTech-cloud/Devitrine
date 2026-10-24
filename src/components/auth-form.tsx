'use client'

import { useActionState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type State = { error?: string; info?: string }

export function AuthForm({
  action,
  submitLabel,
  withRole,
}: {
  action: (state: State, formData: FormData) => Promise<State>
  submitLabel: string
  withRole?: boolean
}) {
  const [state, formAction, pending] = useActionState(action, {})
  return (
    <form action={formAction} className="space-y-4">
      <label className="block space-y-1 text-sm">
        <span>E-mail</span>
        <Input name="email" type="email" autoComplete="email" required />
      </label>
      <label className="block space-y-1 text-sm">
        <span>Senha</span>
        <Input
          name="password"
          type="password"
          autoComplete={withRole ? 'new-password' : 'current-password'}
          required
        />
      </label>
      {withRole && (
        <fieldset className="space-y-1 text-sm">
          <legend>Quero</legend>
          <label className="mr-4">
            <input type="radio" name="role" value="client" defaultChecked /> Comprar serviços
          </label>
          <label>
            <input type="radio" name="role" value="dev" /> Vender serviços
          </label>
        </fieldset>
      )}
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
      <Button type="submit" disabled={pending}>
        {submitLabel}
      </Button>
    </form>
  )
}
