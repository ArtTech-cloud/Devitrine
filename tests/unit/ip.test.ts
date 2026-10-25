import { describe, expect, it } from 'vitest'
import { ipRateLimitKey } from '@/lib/ip'

describe('ipRateLimitKey', () => {
  it('mantém IPv4', () => {
    expect(ipRateLimitKey('203.0.113.7')).toBe('203.0.113.7')
    expect(ipRateLimitKey(' 203.0.113.7 ')).toBe('203.0.113.7')
  })

  it('IPv6 do mesmo /64 cai no mesmo balde, em qualquer notação', () => {
    const base = ipRateLimitKey('2001:db8:aaaa:bbbb::1')
    expect(base).toBe('2001:db8:aaaa:bbbb::/64')
    for (const v of [
      '2001:DB8:AAAA:BBBB:ffff:ffff:ffff:ffff',
      '2001:0db8:aaaa:bbbb:0:0:0:2',
      '2001:db8:aaaa:bbbb:1234::9',
      '2001:db8:aaaa:bbbb::',
    ]) {
      expect(ipRateLimitKey(v)).toBe(base)
    }
  })

  it('/64 diferentes ficam em baldes diferentes', () => {
    expect(ipRateLimitKey('2001:db8:aaaa:bbbc::1')).not.toBe(ipRateLimitKey('2001:db8:aaaa:bbbb::1'))
  })

  it('::1, :: e prefixo curto com :: não quebram', () => {
    expect(ipRateLimitKey('::1')).toBe('0:0:0:0::/64')
    expect(ipRateLimitKey('::')).toBe('0:0:0:0::/64')
    expect(ipRateLimitKey('2001:db8::1')).toBe('2001:db8:0:0::/64')
  })

  it('IPv4 mapeado em IPv6 vira o IPv4', () => {
    expect(ipRateLimitKey('::ffff:203.0.113.7')).toBe('203.0.113.7')
    expect(ipRateLimitKey('::ffff:cb00:7107')).toBe('203.0.113.7')
  })

  it('ignora zona de escopo', () => {
    expect(ipRateLimitKey('fe80::1%eth0')).toBe(ipRateLimitKey('fe80::2'))
  })

  it('lixo, vazio e header forjado viram um único balde "unknown"', () => {
    for (const v of ['', 'unknown', 'abc', '1.2.3', '999.1.1.1', "1.1.1.1'; drop table x", 'a'.repeat(5000)]) {
      expect(ipRateLimitKey(v)).toBe('unknown')
    }
  })
})
