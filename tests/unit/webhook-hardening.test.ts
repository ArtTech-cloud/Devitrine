import { describe, expect, it } from 'vitest'
import { PaymentProviderError, type PaymentProvider } from '@/modules/payments'
import { withProviderTimeout } from '@/modules/payments/infra/timeout-payment-provider'
import { createAuthFailureThrottle } from '@/modules/webhooks/domain/auth-failures'
import { readBodyWithLimit } from '@/modules/webhooks/domain/body-limit'

const enc = new TextEncoder()

/** Stream que entrega `chunks` de 1 KB e registra quantos foram puxados e se a leitura foi cancelada. */
function chunkedBody(chunks: number) {
  const state = { pulled: 0, cancelled: false }
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled >= chunks) return controller.close()
      state.pulled += 1
      controller.enqueue(enc.encode('x'.repeat(1024)))
    },
    cancel() {
      state.cancelled = true
    },
  })
  return { body, state }
}

describe('L1: leitura do corpo com teto antes de autenticar', () => {
  it('Content-Length acima do teto recusa sem ler nenhum byte do stream', async () => {
    const { body, state } = chunkedBody(10)
    const result = await readBodyWithLimit({ headers: new Headers({ 'content-length': '5000' }), body }, 4096)
    expect(result).toEqual({ ok: false, reason: 'too_large' })
    // O stream nem chegou a ser aberto para leitura (o próprio ReadableStream pode pré-puxar um pedaço).
    expect(body.locked).toBe(false)
    expect(state.pulled).toBeLessThanOrEqual(1)
  })

  it('sem Content-Length (ou mentindo), conta os bytes e cancela a leitura ao passar do teto', async () => {
    for (const headers of [new Headers(), new Headers({ 'content-length': '10' })]) {
      const { body, state } = chunkedBody(1000)
      const result = await readBodyWithLimit({ headers, body }, 4096)
      expect(result).toEqual({ ok: false, reason: 'too_large' })
      expect(state.cancelled).toBe(true)
      // Parou perto do teto, não leu o corpo inteiro (1000 KB).
      expect(state.pulled).toBeLessThanOrEqual(6)
    }
  })

  it('corpo dentro do teto volta inteiro, inclusive com acentos; corpo ausente vira vazio', async () => {
    const text = JSON.stringify({ nome: 'ação ✓' })
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        const bytes = enc.encode(text)
        // Corta no meio de um caractere multibyte: o decode só pode acontecer depois de juntar os pedaços.
        c.enqueue(bytes.slice(0, 10))
        c.enqueue(bytes.slice(10))
        c.close()
      },
    })
    expect(await readBodyWithLimit({ headers: new Headers(), body }, 4096)).toEqual({ ok: true, body: text })
    expect(await readBodyWithLimit({ headers: new Headers(), body: null }, 4096)).toEqual({ ok: true, body: '' })
  })

  it('Content-Length inválido não derruba a leitura: vale a contagem do stream', async () => {
    const { body } = chunkedBody(1)
    const result = await readBodyWithLimit({ headers: new Headers({ 'content-length': 'abc' }), body }, 4096)
    expect(result.ok).toBe(true)
  })
})

describe('L2: alerta de 401 limitado por janela', () => {
  it('um alerta por janela, com a contagem dos silenciados', () => {
    let t = 1_000_000
    const throttle = createAuthFailureThrottle(60_000, () => t)
    expect(throttle.record()).toEqual({ alert: true, suppressed: 0 })
    for (let i = 0; i < 99; i++) expect(throttle.record().alert).toBe(false)
    t += 59_999
    expect(throttle.record().alert).toBe(false)
    t += 1
    expect(throttle.record()).toEqual({ alert: true, suppressed: 100 })
    expect(throttle.record().alert).toBe(false)
  })
})

describe('L6: timeout nas chamadas ao gateway', () => {
  const slow = () => new Promise<never>(() => undefined)
  const provider = {
    name: 'fake',
    getCharge: slow,
    createCharge: async () => 'criada',
    parseWebhook: slow,
    simulateSync: () => 42,
  } as unknown as PaymentProvider

  it('chamada pendurada rejeita com timeout; chamada rápida passa; o que não é rede fica de fora', async () => {
    const wrapped = withProviderTimeout(provider, 20)
    await expect(wrapped.getCharge('x')).rejects.toMatchObject({ name: 'PaymentProviderError', code: 'timeout' })
    await expect(wrapped.getCharge('x')).rejects.toBeInstanceOf(PaymentProviderError)
    expect(await wrapped.createCharge({} as never)).toBe('criada')
    expect(wrapped.name).toBe('fake')
    expect((wrapped as unknown as { simulateSync(): number }).simulateSync()).toBe(42)
    // parseWebhook é local: não ganha timer (a promessa dele não é interrompida pelo wrapper).
    expect(wrapped.parseWebhook).toBe(provider.parseWebhook)
  })

  it('erro do gateway passa como está, sem virar timeout', async () => {
    const failing = {
      name: 'fake',
      getCharge: async () => {
        throw new PaymentProviderError('not_found', 'sumiu')
      },
    } as unknown as PaymentProvider
    await expect(withProviderTimeout(failing, 1000).getCharge('x')).rejects.toMatchObject({ code: 'not_found' })
  })
})
