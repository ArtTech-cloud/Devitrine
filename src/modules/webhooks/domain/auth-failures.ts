// Falha de autenticação do webhook (401) não pode virar alerta por requisição: quem conhece a URL poderia inundar o
// canal de alertas (ADR-020 item 21). O log de cada 401 segue (sem `alert: true`); o alerta sai uma vez por janela.

export interface AuthFailureDecision {
  /** Este 401 deve disparar alerta? */
  alert: boolean
  /** Quantos 401 foram silenciados desde o último alerta (só faz sentido quando `alert` é `true`). */
  suppressed: number
}

export interface AuthFailureThrottle {
  record(): AuthFailureDecision
}

/** Janela padrão entre alertas de 401. */
export const AUTH_FAILURE_ALERT_WINDOW_MS = 5 * 60_000

export function createAuthFailureThrottle(
  windowMs: number = AUTH_FAILURE_ALERT_WINDOW_MS,
  now: () => number = Date.now,
): AuthFailureThrottle {
  let lastAlertAt = Number.NEGATIVE_INFINITY
  let suppressed = 0
  return {
    record() {
      const t = now()
      if (t - lastAlertAt >= windowMs) {
        const decision = { alert: true, suppressed }
        lastAlertAt = t
        suppressed = 0
        return decision
      }
      suppressed += 1
      return { alert: false, suppressed }
    },
  }
}
