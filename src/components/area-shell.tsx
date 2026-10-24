import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardTitle } from '@/components/ui/card'
import { signOutAction } from '@/modules/accounts'

export function AreaShell({ title, email, role }: { title: string; email: string; role: string }) {
  return (
    <Card className="space-y-4">
      <CardTitle>{title}</CardTitle>
      <p className="text-sm text-muted-foreground">
        Logado como <span data-testid="user-email">{email}</span>{' '}
        <Badge data-testid="user-role">{role}</Badge>
      </p>
      <form action={signOutAction}>
        <Button type="submit" variant="outline">
          Sair
        </Button>
      </form>
    </Card>
  )
}
