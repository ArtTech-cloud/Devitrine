import { describe, expect, it } from 'vitest'
import { jsonLd, priceForSchema } from '@/lib/seo'

describe('jsonLd', () => {
  it('conteúdo do dev não fecha a tag <script> nem abre comentário HTML', () => {
    const out = jsonLd({ name: '</script><script>alert(1)</script>', d: '<!-- x --> & <img src=x onerror=1>' })
    expect(out).not.toMatch(/[<>&]/)
    expect(out).not.toContain('</script')
  })

  it('o JSON escapado volta idêntico ao original', () => {
    const data = { name: '</script>"\   & <b>', n: [1, 'a>b'] }
    expect(JSON.parse(jsonLd(data))).toEqual(data)
  })
})

describe('priceForSchema', () => {
  it('formata centavos sem ponto flutuante', () => {
    expect(priceForSchema(0n)).toBe('0.00')
    expect(priceForSchema(5n)).toBe('0.05')
    expect(priceForSchema(10_000_000n)).toBe('100000.00')
    expect(priceForSchema(123_456_789_012_345_678n)).toBe('1234567890123456.78')
  })
})
