'use client'

import { useActionState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

export function MfaForm({
  factorId,
  qrCode,
  secret,
  action,
}: {
  factorId: string
  qrCode: string | null
  secret: string | null
  action: (state: { error?: string }, formData: FormData) => Promise<{ error?: string }>
}) {
  const [state, formAction, pending] = useActionState(action, {})
  return (
    <Card className="space-y-4">
      <CardTitle>Verificação em duas etapas</CardTitle>
      {qrCode ? (
        <>
          <p className="text-sm">
            Admin precisa de TOTP. Escaneie o QR Code no seu app autenticador.
          </p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={qrCode} alt="QR Code do autenticador" width={192} height={192} />
          <p className="text-sm">
            Ou digite a chave: <code data-testid="totp-secret">{secret}</code>
          </p>
        </>
      ) : (
        <p className="text-sm">Informe o código do seu app autenticador.</p>
      )}
      <form action={formAction} className="space-y-4">
        <input type="hidden" name="factorId" value={factorId} />
        <Input
          name="code"
          inputMode="numeric"
          pattern="\d{6}"
          maxLength={6}
          placeholder="000000"
          aria-label="Código de 6 dígitos"
          required
        />
        {state.error && (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        )}
        <Button type="submit" disabled={pending}>
          Verificar
        </Button>
      </form>
    </Card>
  )
}
