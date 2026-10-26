import 'server-only'
import { withContext } from '@/lib/logger'
import { readBodyWithLimit } from '../domain/body-limit'
import { MAX_BODY_BYTES } from '../domain/policy'
import type { WebhookDeps } from './deps'
import { receiveWebhook } from './receive'

/**
 * Tudo o que a rota faz, fora do Route Handler para poder ser testado: lê o corpo bruto com teto (antes de autenticar),
 * entrega ao `receiveWebhook` e traduz qualquer exceção inesperada em 500 com log `webhook_receive_failed`
 * (o provedor reenvia). Nenhuma exceção escapa sem registro.
 */
export async function handleWebhookRequest(req: Request, deps: WebhookDeps | (() => WebhookDeps)): Promise<Response> {
  try {
    const read = await readBodyWithLimit(req, MAX_BODY_BYTES)
    if (!read.ok) return Response.json({ ok: false, error: 'payload_too_large' }, { status: 413 })
    const result = await receiveWebhook(read.body, req.headers, typeof deps === 'function' ? deps() : deps)
    return Response.json(result.body, { status: result.status })
  } catch (error) {
    withContext({}).error({ alertCode: 'webhook_receive_failed', err: error }, 'falha inesperada ao receber webhook')
    return Response.json({ ok: false, error: 'internal' }, { status: 500 })
  }
}
