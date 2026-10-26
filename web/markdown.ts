// The Markdown Claude writes, as DOM nodes built one by one: text always goes in as text, never as HTML, so nothing a
// session says can run in the page. Code blocks, tables, headings, lists, quotes, and inline code, bold, italics and links.

type Inline = (string | HTMLElement)[]

export function renderMarkdown(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment()
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let index = 0
  const take = (test: (line: string) => boolean) => {
    const taken: string[] = []
    while (index < lines.length && test(lines[index])) taken.push(lines[index++])
    return taken
  }
  while (index < lines.length) {
    const line = lines[index]
    const fence = /^\s*```(\S*)/.exec(line)
    if (fence) {
      index++
      const code = take(l => !/^\s*```/.test(l))
      index++
      const pre = element('pre')
      const block = element('code', code.join('\n'))
      if (fence[1]) block.dataset.language = fence[1]
      pre.append(block)
      fragment.append(pre)
    } else if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1] ?? '')) {
      fragment.append(table(take(l => /^\s*\|.*\|\s*$/.test(l))))
    } else if (/^#{1,6}\s/.test(line)) {
      const level = Math.min(4, (/^#+/.exec(line)?.[0].length ?? 1) + 1)
      fragment.append(element(`h${level}` as 'h2', ...inline(line.replace(/^#+\s*/, ''))))
      index++
    } else if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line)
      const list = element(ordered ? 'ol' : 'ul')
      for (const item of take(l => /^\s*([-*+]|\d+[.)])\s+/.test(l)))
        list.append(element('li', ...inline(item.replace(/^\s*([-*+]|\d+[.)])\s+/, ''))))
      fragment.append(list)
    } else if (/^\s*>/.test(line)) {
      const quote = take(l => /^\s*>/.test(l)).map(l => l.replace(/^\s*>\s?/, ''))
      fragment.append(element('blockquote', ...inline(quote.join('\n'))))
    } else if (!line.trim()) {
      index++
    } else {
      const paragraph = take(l => l.trim() !== '' && !/^\s*(```|#{1,6}\s|>|([-*+]|\d+[.)])\s+)/.test(l))
      fragment.append(element('p', ...inline(paragraph.join('\n'))))
    }
  }
  return fragment
}

function table(rows: string[]): HTMLElement {
  const cells = (row: string) =>
    row
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map(cell => cell.trim())
  const wrapper = element('div')
  wrapper.className = 'table'
  const grid = element('table')
  const [header, , ...body] = rows
  const head = element('tr')
  for (const cell of cells(header)) head.append(element('th', ...inline(cell)))
  grid.append(head)
  for (const row of body) {
    const line = element('tr')
    for (const cell of cells(row)) line.append(element('td', ...inline(cell)))
    grid.append(line)
  }
  wrapper.append(grid)
  return wrapper
}

/** `code`, **bold**, *italics* and [links](https://…), the rest as plain text with its line breaks. */
export function inline(text: string): Inline {
  const parts: Inline = []
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|(?<![\w*])\*([^*\s][^*]*)\*(?![\w*])|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g
  let last = 0
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) parts.push(...breaks(text.slice(last, match.index)))
    if (match[1] !== undefined) parts.push(element('code', match[1]))
    else if (match[2] !== undefined) parts.push(element('strong', match[2]))
    else if (match[3] !== undefined) parts.push(element('em', match[3]))
    else {
      const link = element('a', match[4])
      link.setAttribute('href', match[5])
      link.setAttribute('target', '_blank')
      link.setAttribute('rel', 'noopener noreferrer')
      parts.push(link)
    }
    last = match.index + match[0].length
  }
  if (last < text.length) parts.push(...breaks(text.slice(last)))
  return parts
}

function breaks(text: string): Inline {
  return text.split('\n').flatMap((line, index) => (index === 0 ? [line] : [element('br'), line]))
}

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, ...children: (string | Node)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.append(...children)
  return node
}
