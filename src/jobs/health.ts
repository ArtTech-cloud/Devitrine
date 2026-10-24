import { inngest } from './client'

export const healthPing = inngest.createFunction(
  { id: 'health-ping', triggers: [{ event: 'app/health.ping' }] },
  async () => ({ ok: true }),
)
