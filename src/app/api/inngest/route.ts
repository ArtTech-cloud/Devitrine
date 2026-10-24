import { serve } from 'inngest/next'
import { inngest } from '@/jobs/client'
import { healthPing } from '@/jobs/health'

export const runtime = 'nodejs'

export const { GET, POST, PUT } = serve({ client: inngest, functions: [healthPing] })
