export const DEV_STATUSES = ['pending', 'approved', 'suspended'] as const
export type DevStatus = (typeof DEV_STATUSES)[number]

const ALLOWED: Record<DevStatus, readonly DevStatus[]> = {
  pending: ['approved', 'suspended'],
  approved: ['suspended'],
  suspended: ['approved'],
}

/** Espelha admin_set_dev_status (migração 0006); o banco é a palavra final. */
export function canTransitionDev(from: DevStatus, to: DevStatus): boolean {
  return ALLOWED[from].includes(to)
}
