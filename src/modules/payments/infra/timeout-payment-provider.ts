import { PaymentProviderError } from '../domain/errors'
import type { PaymentProvider } from '../domain/provider'

/**
 * Teto de espera por chamada ao gateway. Sem ele, uma chamada pendurada segura a transação do job (e a trava
 * advisory) até o runtime matar a função (ADR-020 item 23).
 */
export const PROVIDER_TIMEOUT_MS = 15_000

/** Métodos que não saem para a rede: autenticam e normalizam o corpo já recebido. */
const LOCAL_METHODS: ReadonlySet<string | symbol> = new Set(['parseWebhook', 'name'])

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  !!v && typeof (v as { then?: unknown }).then === 'function'

/**
 * Envolve um `PaymentProvider` para que toda chamada de rede rejeite com `PaymentProviderError('timeout')` depois de
 * `ms`. Não cancela a requisição em andamento: o adaptador real também precisa passar `AbortSignal.timeout(ms)` ao
 * `fetch`. Em `createCharge` o timeout deixa o estado ambíguo (a cobrança pode existir no gateway); por isso a mesma
 * chave de idempotência segue para o gateway, e repetir a chamada devolve a mesma cobrança.
 */
export function withProviderTimeout(provider: PaymentProvider, ms: number = PROVIDER_TIMEOUT_MS): PaymentProvider {
  return new Proxy(provider, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function' || LOCAL_METHODS.has(prop)) return value
      return (...args: unknown[]) => {
        const result: unknown = value.apply(target, args)
        if (!isThenable(result)) return result
        return new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new PaymentProviderError('timeout', `O gateway não respondeu em ${ms} ms (${String(prop)})`)),
            ms,
          )
          result.then(
            (v) => {
              clearTimeout(timer)
              resolve(v)
            },
            (e) => {
              clearTimeout(timer)
              reject(e)
            },
          )
        })
      }
    },
  })
}
