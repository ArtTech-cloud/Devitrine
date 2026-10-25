import 'server-only'
import MarkdownIt from 'markdown-it'
import sanitizeHtml from 'sanitize-html'

// Duas barreiras (ADR-014): markdown-it sem HTML bruto e sanitize-html com allowlist sobre o resultado.
const md = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: true })

// Títulos do dev nunca competem com o h1/h2 da página: h1-h2 viram h3, h3 vira h4, o resto h5.
const HEADING: Record<string, string> = { h1: 'h3', h2: 'h3', h3: 'h4', h4: 'h5', h5: 'h5', h6: 'h5' }

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ['p', 'br', 'strong', 'em', 'ul', 'ol', 'li', 'a', 'code', 'pre', 'blockquote', 'h3', 'h4', 'h5'],
  allowedAttributes: { a: ['href', 'rel', 'target'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  transformTags: {
    ...Object.fromEntries(Object.entries(HEADING).map(([from, to]) => [from, to])),
    a: (tag, attribs) => ({
      tagName: tag,
      attribs: { href: attribs.href ?? '', rel: 'noopener noreferrer nofollow ugc', target: '_blank' },
    }),
  },
}

/** Converte o Markdown do dev em HTML seguro, só com formatação básica. */
export function renderMarkdown(source: string): string {
  return sanitizeHtml(md.render(source), OPTIONS)
}
