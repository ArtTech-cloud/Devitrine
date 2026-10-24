import * as React from 'react'
import { cn } from '@/lib/utils'

/** Status nunca só por cor: texto sempre presente. */
export function Badge({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn('inline-flex items-center rounded-full border border-border px-2.5 py-0.5 text-xs font-medium', className)}
      {...props}
    />
  )
}
