// Leitura do corpo do webhook com teto, ANTES de autenticar (SPEC §9, ADR-020 item 20). `req.text()` carrega tudo
// na memória; sem teto, qualquer um que conheça a URL gastaria memória sem token nenhum.

export type ReadBodyResult = { ok: true; body: string } | { ok: false; reason: 'too_large' }

/**
 * Recusa pelo `Content-Length` quando ele já passa do teto e, como o cabeçalho pode faltar ou mentir, também conta
 * os bytes do stream e cancela a leitura assim que o teto é ultrapassado. Nunca decodifica nem faz parse antes.
 */
export async function readBodyWithLimit(
  req: { headers: Headers; body: ReadableStream<Uint8Array> | null },
  maxBytes: number,
): Promise<ReadBodyResult> {
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, reason: 'too_large' }
  if (!req.body) return { ok: true, body: '' }

  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      return { ok: false, reason: 'too_large' }
    }
    chunks.push(value)
  }
  return { ok: true, body: Buffer.concat(chunks).toString('utf8') }
}
