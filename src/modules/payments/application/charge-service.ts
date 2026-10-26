import 'server-only'
import { createHash } from 'node:crypto'
import type { Db } from '@/lib/db'
import { newId } from '@/lib/ids'
import { withContext } from '@/lib/logger'
import { assertChargeInput, fingerprint, splitFitsNet } from '../domain/charge-rules'
import { PaymentProviderError } from '../domain/errors'
import type { AlertSink } from '../domain/ports'
import type { Charge, CreateChargeInput, PaymentProvider } from '../domain/provider'
import {
  advisoryLock,
  findIdempotencyKey,
  findOpenPaymentForOrder,
  findPaymentByProviderId,
  insertIdempotencyKey,
  insertPayment,
  type PaymentRow,
} from '../infra/payments-repository'

export const CREATE_CHARGE_SCOPE = 'payments.create_charge'

export interface CreateOrderChargeInput extends CreateChargeInput {
  /** Dono da carteira (`users.id` do dev): as contas por dev do ledger são dele. */
  devId: string
}

export interface OrderCharge {
  payment: PaymentRow
  charge: Charge
  /** `true` quando a chave já tinha sido usada e esta é a resposta repetida (nenhuma chamada nova de criação ao gateway). */
  replayed: boolean
}

const hashOf = (input: CreateOrderChargeInput) =>
  createHash('sha256')
    .update(
      fingerprint([
        input.orderId,
        input.devId,
        input.method,
        input.grossCents,
        input.devWalletId,
        input.devAmountCents,
        input.customer.cpfCnpj,
      ]),
    )
    .digest('hex')

/**
 * Cria a cobrança no gateway e grava `payments` e a chave em `idempotency_keys` (SPEC §8: toda chamada que cria
 * dinheiro leva chave). Roda na transação de `db`, com trava por chave: a mesma chave chamada duas vezes devolve
 * a mesma cobrança, e com parâmetros diferentes é conflito. A chave também segue para o gateway, que é a defesa
 * se o processo cair entre a chamada e o COMMIT.
 */
export async function createOrderCharge(
  db: Db,
  provider: PaymentProvider,
  input: CreateOrderChargeInput,
  alert: AlertSink,
): Promise<OrderCharge> {
  assertChargeInput(input)
  const requestHash = hashOf(input)
  await advisoryLock(db, `${CREATE_CHARGE_SCOPE}:${input.idempotencyKey}`)

  const seen = await findIdempotencyKey(db, CREATE_CHARGE_SCOPE, input.idempotencyKey)
  if (seen) {
    if (seen.requestHash !== requestHash) {
      throw new PaymentProviderError('idempotency_mismatch', 'Chave de idempotência reutilizada com outros parâmetros')
    }
    const payment = await findPaymentByProviderId(db, provider.name, seen.resultRef)
    if (!payment) throw new PaymentProviderError('conflict', 'Chave registrada sem cobrança correspondente')
    return { payment, charge: await provider.getCharge(seen.resultRef), replayed: true }
  }

  if (await findOpenPaymentForOrder(db, input.orderId)) {
    throw new PaymentProviderError('conflict', 'O pedido já tem uma cobrança aberta ou paga')
  }

  const charge = await provider.createCharge(input)
  const payment = await insertPayment(db, {
    id: newId(),
    orderId: input.orderId,
    provider: provider.name,
    providerPaymentId: charge.providerPaymentId,
    method: charge.method,
    status: charge.status,
    devId: input.devId,
    devWalletId: input.devWalletId,
    grossCents: charge.grossCents,
    devAmountCents: charge.devAmountCents,
    netCents: charge.netCents,
    splitStatus: charge.splitStatus,
    checkoutUrl: charge.checkoutUrl,
  })
  await insertIdempotencyKey(db, {
    scope: CREATE_CHARGE_SCOPE,
    key: input.idempotencyKey,
    requestHash,
    resultRef: charge.providerPaymentId,
  })

  if (charge.netCents !== null && !splitFitsNet(charge.devAmountCents, charge.netCents)) {
    // A parte do dev não cabe no líquido: o gateway bloqueia o split (SPEC §8, item 4).
    alert({
      severity: 'critical',
      code: 'split_exceeds_net',
      message: 'A parte do dev é maior que o líquido da cobrança',
      context: { orderId: input.orderId, providerPaymentId: charge.providerPaymentId },
    })
  }
  withContext({ orderId: input.orderId }).info(
    { providerPaymentId: charge.providerPaymentId, method: charge.method },
    'cobrança criada',
  )
  return { payment, charge, replayed: false }
}
