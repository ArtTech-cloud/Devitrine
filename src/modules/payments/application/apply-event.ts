import 'server-only'
import type { Db } from '@/lib/db'
import { paymentConfirmed, postLedgerTx } from '@/modules/ledger'
import { PaymentProviderError } from '../domain/errors'
import { planPaymentSync } from '../domain/payment-sync'
import type { AlertSink, OrderPaymentEffects } from '../domain/ports'
import type { Charge, NormalizedEvent } from '../domain/provider'
import { advisoryLock, findPaymentByProviderId, updatePayment } from '../infra/payments-repository'

/** Chave de idempotência do lançamento de pagamento: um por cobrança, qualquer que seja o evento que o dispare. */
export const paymentConfirmedKey = (provider: string, providerPaymentId: string) =>
  `payment_confirmed:${provider}:${providerPaymentId}`

export type ApplyResult = 'applied' | 'ignored'

export interface ApplyEventContext {
  event: Pick<NormalizedEvent, 'provider' | 'type' | 'rawType' | 'providerPaymentId' | 'splitId'>
  /** Cobrança lida no provedor agora (o payload do webhook não é fonte da verdade, SPEC §9 passo 6). */
  charge: Charge | null
  orders: OrderPaymentEffects
  alert: AlertSink
}

/**
 * Aplica um evento de pagamento já autenticado. Roda na transação do job: atualiza `payments`, faz o lançamento
 * no ledger e avisa o pedido, tudo ou nada. É idempotente e não depende da ordem dos eventos: o estado vem da
 * cobrança do provedor e só avança (ver `planPaymentSync`).
 */
export async function applyPaymentEvent(db: Db, ctx: ApplyEventContext): Promise<ApplyResult> {
  const { event, charge, orders, alert } = ctx
  if (event.type === 'ignored') return 'ignored'
  if (!event.providerPaymentId || !charge) {
    throw new PaymentProviderError('validation', 'Evento de pagamento sem cobrança correspondente')
  }
  const pid = event.providerPaymentId
  await advisoryLock(db, `payment:${event.provider}:${pid}`)
  const stored = await findPaymentByProviderId(db, event.provider, pid, { forUpdate: true })
  // Pode chegar antes de `createOrderCharge` fechar a transação dele: erro com retry, nunca descartar.
  if (!stored) throw new PaymentProviderError('not_found', 'Cobrança ainda não registrada em payments')

  const plan = planPaymentSync(
    {
      status: stored.status as Charge['status'],
      splitStatus: stored.splitStatus as Charge['splitStatus'],
      grossCents: stored.grossCents,
      devAmountCents: stored.devAmountCents,
      devWalletId: stored.devWalletId,
      netCents: stored.netCents,
      escrowId: stored.escrowId,
      confirmedAt: stored.confirmedAt,
    },
    charge,
  )

  if (plan.mismatches.length > 0) {
    // Falha fechado: nada é gravado, lançado nem avisado ao pedido. O erro desfaz a transação e o evento fica em
    // retry (e vira `failed` com alerta se a divergência persistir); uma pessoa corrige no gateway ou na conciliação.
    alert({
      severity: 'critical',
      code: 'charge_mismatch',
      message: `Cobrança diverge do que foi gravado: ${plan.mismatches.join(', ')}. Evento não aplicado`,
      context: { orderId: stored.orderId, providerPaymentId: pid },
    })
    throw new PaymentProviderError('conflict', `Cobrança ${pid} diverge do gravado (${plan.mismatches.join(', ')})`)
  }

  if (plan.paidAfterCancel) {
    // Pago no gateway depois de vencer ou ser apagada: o pedido já foi cancelado. Não lança, não confirma e não
    // reabre o pedido sozinho; o dinheiro está no gateway e a devolução é decisão humana (SPEC §9).
    alert({
      severity: 'critical',
      code: 'paid_after_cancel',
      message: `Cobrança ${stored.status} paga no gateway (${charge.status}): devolver ao cliente ou decidir o pedido manualmente`,
      context: { orderId: stored.orderId, providerPaymentId: pid, storedStatus: stored.status, gatewayStatus: charge.status },
    })
    return 'applied'
  }

  if (plan.firstPaid) {
    if (plan.netCents === null) {
      throw new PaymentProviderError('conflict', 'Cobrança paga sem líquido informado pelo provedor')
    }
    await updatePayment(db, stored.id, {
      status: plan.status,
      splitStatus: plan.splitStatus,
      netCents: plan.netCents,
      confirmedAt: charge.paidAt ?? new Date(),
    })
    await postLedgerTx(
      db,
      paymentConfirmed({
        idempotencyKey: paymentConfirmedKey(event.provider, pid),
        orderId: stored.orderId,
        grossCents: stored.grossCents,
        netCents: plan.netCents,
      }),
    )
    if (plan.status === 'confirmed' || plan.status === 'received') {
      await orders.onPaymentConfirmed(db, { orderId: stored.orderId, paymentId: stored.id, providerPaymentId: pid })
    } else {
      alert({
        severity: 'critical',
        code: 'paid_and_reversed_unseen',
        message: 'Cobrança já estava estornada ou contestada na primeira vez que foi vista como paga',
        context: { orderId: stored.orderId, providerPaymentId: pid },
      })
    }
  } else if (plan.changed) {
    await updatePayment(db, stored.id, {
      status: plan.status,
      splitStatus: plan.splitStatus,
      netCents: plan.netCents,
    })
  }

  if (plan.cancelled) {
    await orders.onPaymentCancelled(db, { orderId: stored.orderId, paymentId: stored.id, providerPaymentId: pid })
  }

  raiseEventAlerts(event, stored.orderId, alert)
  return 'applied'
}

/** Eventos que exigem uma pessoa: split bloqueado ou cancelado, e estorno ou chargeback (lançamento é da Fase 3). */
function raiseEventAlerts(event: ApplyEventContext['event'], orderId: string, alert: AlertSink) {
  const context = { orderId, providerPaymentId: event.providerPaymentId, splitId: event.splitId }
  switch (event.type) {
    case 'split_divergence_block':
      alert({
        severity: 'critical',
        code: 'split_divergence_block',
        message: 'Split bloqueado por divergência: corrigir em até dois dias úteis',
        context,
      })
      break
    case 'split_cancelled':
      alert({
        severity: 'critical',
        code: 'split_cancelled',
        message: 'Split cancelado: acertar a parte do dev manualmente',
        context,
      })
      break
    case 'payment_refunded':
    case 'payment_partially_refunded':
    case 'chargeback_requested':
    case 'chargeback_dispute':
    case 'chargeback_reversal_awaiting':
      alert({
        severity: 'warning',
        code: 'reversal_not_booked',
        message: `${event.rawType}: o status foi atualizado, mas o lançamento de estorno ou chargeback é da Fase 3 e ainda não foi feito`,
        context,
      })
      break
    default:
      break
  }
}

