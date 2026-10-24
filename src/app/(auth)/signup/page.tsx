import Link from 'next/link'
import { AuthForm } from '@/components/auth-form'
import { Card, CardTitle } from '@/components/ui/card'
import { signUpAction } from '@/modules/accounts'

export default function SignupPage() {
  return (
    <Card className="space-y-4">
      <CardTitle>Criar conta</CardTitle>
      <AuthForm action={signUpAction} submitLabel="Criar conta" withRole />
      <p className="text-sm">
        Já tem conta?{' '}
        <Link className="underline" href="/login">
          Entrar
        </Link>
      </p>
    </Card>
  )
}
