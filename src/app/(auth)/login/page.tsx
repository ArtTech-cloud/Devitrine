import Link from 'next/link'
import { AuthForm } from '@/components/auth-form'
import { Card, CardTitle } from '@/components/ui/card'
import { signInAction } from '@/modules/accounts'

export default function LoginPage() {
  return (
    <Card className="space-y-4">
      <CardTitle>Entrar</CardTitle>
      <AuthForm action={signInAction} submitLabel="Entrar" />
      <p className="text-sm">
        Sem conta?{' '}
        <Link className="underline" href="/signup">
          Criar conta
        </Link>
      </p>
    </Card>
  )
}
