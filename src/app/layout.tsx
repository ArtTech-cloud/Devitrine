import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { Toaster } from 'sonner'
import './globals.css'

export const metadata: Metadata = {
  title: 'Marketplace de serviços digitais',
  description: 'Pacotes fechados de devs independentes, com pagamento em custódia até a aprovação.',
}

// Páginas dinâmicas: a CSP com nonce (src/proxy.ts) é por requisição.
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await headers()
  return (
    <html lang="pt-BR">
      <body>
        <main className="mx-auto max-w-3xl p-6">{children}</main>
        <Toaster />
      </body>
    </html>
  )
}
