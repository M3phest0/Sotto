import { renderInlineMarkdown } from './markdown'

export function MarkdownInline({
  text,
  links = 'inert',
}: {
  text: string
  links?: 'inert' | 'external'
}) {
  const html = renderInlineMarkdown(text, links)
  return <span className="md-inline" dangerouslySetInnerHTML={{ __html: html }} />
}
