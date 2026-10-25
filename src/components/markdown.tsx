import { renderMarkdown } from '@/lib/markdown'

/** Markdown do dev já sanitizado (allowlist); nunca passe HTML que não venha de `renderMarkdown`. */
export function Markdown({ source }: { source: string }) {
  return (
    <div
      className="space-y-2 text-sm [&_a]:underline [&_h3]:text-base [&_h3]:font-semibold [&_h4]:font-semibold [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-x-auto [&_ul]:list-disc [&_ul]:pl-5"
      dangerouslySetInnerHTML={{ __html: renderMarkdown(source) }}
    />
  )
}
