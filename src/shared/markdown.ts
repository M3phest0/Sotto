import MarkdownIt from 'markdown-it'

type LinkMode = 'inert' | 'external'

type MarkdownItInstance = ReturnType<typeof MarkdownIt>

const renderers = new Map<LinkMode, MarkdownItInstance>()

function buildRenderer(linkMode: LinkMode): MarkdownItInstance {
  const md = new MarkdownIt({
    html: false,
    linkify: false,
    breaks: false,
    typographer: false,
  })

  md.renderer.rules.image = (tokens, idx) => {
    return md.utils.escapeHtml(tokens[idx].content ?? '')
  }

  md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
    if (linkMode === 'inert') {
      return '<span class="md-link">'
    }
    tokens[idx].attrSet('target', '_blank')
    tokens[idx].attrSet('rel', 'noreferrer noopener')
    return self.renderToken(tokens, idx, options)
  }

  md.renderer.rules.link_close = () => {
    return linkMode === 'inert' ? '</span>' : '</a>'
  }

  return md
}

function getRenderer(linkMode: LinkMode): MarkdownItInstance {
  const existing = renderers.get(linkMode)
  if (existing) return existing
  const md = buildRenderer(linkMode)
  renderers.set(linkMode, md)
  return md
}

export function renderInlineMarkdown(text: string, linkMode: LinkMode = 'inert'): string {
  return getRenderer(linkMode).renderInline(text)
}

export function renderFullMarkdown(text: string, linkMode: LinkMode = 'inert'): string {
  return getRenderer(linkMode).render(text)
}
