import { isIP } from 'node:net'

/** Expande um IPv6 válido para 8 grupos de 16 bits (inteiros). */
function ipv6Groups(ip: string): number[] {
  let head = ip
  let tail = ''
  const gap = ip.indexOf('::')
  if (gap !== -1) {
    head = ip.slice(0, gap)
    tail = ip.slice(gap + 2)
  }
  const toGroups = (s: string): number[] => {
    if (!s) return []
    const parts = s.split(':')
    const last = parts[parts.length - 1]!
    if (last.includes('.')) {
      const [a, b, c, d] = last.split('.').map(Number) as [number, number, number, number]
      parts.splice(parts.length - 1, 1, ((a << 8) | b).toString(16), ((c << 8) | d).toString(16))
    }
    return parts.map((p) => parseInt(p, 16))
  }
  const h = toGroups(head)
  const t = toGroups(tail)
  return gap === -1 ? h : [...h, ...Array<number>(8 - h.length - t.length).fill(0), ...t]
}

/**
 * Chave de IP para rate limit. IPv4 fica como está; IPv4 mapeado em IPv6 vira IPv4; IPv6 vira o
 * prefixo /64 (quem tem uma rede IPv6 controla 2^64 endereços, então o endereço exato não limita nada).
 * Valor que não é IP vira "unknown" (um único balde), para header forjado não abrir baldes novos.
 */
export function ipRateLimitKey(raw: string): string {
  const ip = raw.trim().replace(/%.*$/, '').toLowerCase()
  const kind = isIP(ip)
  if (kind === 4) return ip
  if (kind !== 6) return 'unknown'
  const g = ipv6Groups(ip)
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return `${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`
  }
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`
}
