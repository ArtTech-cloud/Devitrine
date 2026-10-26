import { serve } from 'inngest/next'
import { inngest } from '@/jobs/client'
import { healthPing } from '@/jobs/health'
import { reconcileDaily } from '@/jobs/reconciliation'
import { processWebhook, sweepWebhooks } from '@/jobs/webhooks'

export const runtime = 'nodejs'

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [healthPing, processWebhook, sweepWebhooks, reconcileDaily],
})
