import Link from 'next/link'
import { Button } from '@/components/ui/button'

export default function Home() {
  return (
    <section className="space-y-4 py-16">
      <h1 className="text-3xl font-semibold">Marketplace de serviços digitais</h1>
      <p className="text-muted-foreground">
        Compre pacotes fechados de devs independentes. O pagamento fica em custódia até você aprovar a
        entrega.
      </p>
      <div className="flex gap-3">
        <Button asChild>
          <Link href="/pacotes">Ver pacotes</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/signup">Criar conta</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/login">Entrar</Link>
        </Button>
      </div>
    </section>
  )
}
