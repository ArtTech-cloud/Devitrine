import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const { renderMarkdown } = await import('@/lib/markdown')

describe('renderMarkdown', () => {
  it('renderiza a formatação básica', () => {
    const html = renderMarkdown('# Título\n\n**negrito** e *itálico* e `código`\n\n- um\n- dois\n\n[site](https://exemplo.com)')
    expect(html).toContain('<h3>Título</h3>')
    expect(html).toContain('<strong>negrito</strong>')
    expect(html).toContain('<em>itálico</em>')
    expect(html).toContain('<code>código</code>')
    expect(html).toContain('<li>um</li>')
    expect(html).toMatch(/<a href="https:\/\/exemplo\.com" rel="noopener noreferrer nofollow ugc" target="_blank">site<\/a>/)
  })

  it('não deixa HTML bruto passar (aparece como texto escapado)', () => {
    const html = renderMarkdown('<script>alert(1)</script><img src=x onerror=alert(1)><iframe src="//x"></iframe>')
    expect(html).not.toMatch(/<(script|img|iframe)/i)
    expect(html).not.toMatch(/<[^>]*onerror/i)
  })

  it.each([
    '[x](javascript:alert(1))',
    '[x](JaVaScRiPt:alert(1))',
    '[x](&#106;avascript:alert(1))',
    '[x](data:text/html;base64,PHNjcmlwdD4=)',
    '[x](vbscript:msgbox(1))',
    '[x](//evil.com)',
    '<a href="javascript:alert(1)">x</a>',
    '<javascript:alert(1)>',
  ])('bloqueia esquema perigoso: %s', (src) => {
    const html = renderMarkdown(src)
    expect(html).not.toMatch(/<a [^>]*href="(javascript|data|vbscript|\/\/)/i)
    expect(html).not.toMatch(/<a [^>]*href="[^"]*(javascript|vbscript|data):/i)
  })

  it('remove imagens e tabelas (fora da allowlist)', () => {
    const html = renderMarkdown('![x](https://exemplo.com/a.png)\n\n| a | b |\n|---|---|\n| 1 | 2 |')
    expect(html).not.toMatch(/<img|<table/i)
  })

  it('não gera atributos de evento nem style', () => {
    const html = renderMarkdown('**x**{onclick=alert(1)} <b style="x" onmouseover="y">z</b>')
    expect(html).not.toMatch(/<[^>]*(\son\w+=|style=)/i)
  })

  it('mantém mailto e http', () => {
    expect(renderMarkdown('[a](mailto:a@b.com) [b](http://b.com)')).toMatch(/href="mailto:a@b\.com".*href="http:\/\/b\.com"/)
  })

  it.each([
    '[x](java&#x0A;script:alert(1))',
    '[x](jav&#x09;ascript:alert(1))',
    '[x](%6Aavascript:alert(1))',
    '[x](&#0000106avascript:alert(1))',
    '[x](<javascript:alert(1)>)',
    '[x][r]\n\n[r]: javascript:alert(1)',
    '![x](javascript:alert(1))',
  ])('esquema ofuscado não vira link executável: %s', (src) => {
    const html = renderMarkdown(src)
    for (const [, href] of html.matchAll(/href="([^"]*)"/g)) {
      expect(href!.replace(/[\u0000- ]/g, '')).not.toMatch(/^(javascript|vbscript|data):/i)
    }
  })

  it('código e citação mantêm HTML como texto', () => {
    const html = renderMarkdown('```html\n<script>alert(1)</script>\n```\n\n`</code><script>1</script>`\n\n> <b onclick=1>q</b>')
    expect(html).not.toMatch(/<(script|b)[\s>]/i)
  })
})
