import { getWebhookDeps } from '@/lib/composition'
import { reconcilePayments } from '@/modules/payments'
import { inngest } from './client'

/** Conciliação diária das últimas 72 h (SPEC §9): gateway x payments x ledger. 07:00 UTC = 04:00 em São Paulo. */
export const reconcileDaily = inngest.createFunction(
  { id: 'payments-reconcile-daily', triggers: [{ cron: '0 7 * * *' }] },
  async () => {
    const deps = getWebhookDeps()
    const report = await deps.run((db) => reconcilePayments(db, deps.provider, deps.alert))
    return { runId: report.runId, chargesChecked: report.chargesChecked, divergences: report.divergences.length }
  },
)
