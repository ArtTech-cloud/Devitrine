import { getWebhookDeps } from '@/lib/composition'
import { receiveWebhook } from '@/modules/webhooks'

// Node (comparação em tempo constante do token) e sem cache: cada entrega é lida e gravada na hora.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Entrada do webhook do gateway (SPEC §9). Lê o corpo BRUTO, autentica antes de qualquer parse, grava, enfileira e
 * responde. Nenhuma regra de negócio roda aqui; ela vive no job `webhooks/process`.
 */
export async function POST(req: Request) {
  const rawBody = await req.text()
  const result = await receiveWebhook(rawBody, req.headers, getWebhookDeps())
  return Response.json(result.body, { status: result.status })
}
