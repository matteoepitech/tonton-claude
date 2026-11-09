// A small stand-in for the DOM, enough for the island's views (web/views.ts, web/cluster-views.ts): elements, text,
// classes, attributes and click handlers, and a way to find elements again.

export class FakeNode {
  parent: FakeElement | null = null
  get text(): string {
    return ''
  }
  get nextSibling(): FakeNode | null {
    const siblings = this.parent?.childNodes ?? []
    return siblings[siblings.indexOf(this) + 1] ?? null
  }
  remove() {
    if (!this.parent) return
    this.parent.childNodes.splice(this.parent.childNodes.indexOf(this), 1)
    this.parent = null
  }
}

export class FakeText extends FakeNode {
  constructor(readonly data: string) {
    super()
  }
  override get text() {
    return this.data
  }
}

export class FakeElement extends FakeNode {
  childNodes: FakeNode[] = []
  className = ''
  title = ''
  attributes = new Map<string, string>()
  onclick: (() => void) | null = null
  constructor(readonly tagName: string) {
    super()
  }
  classList = {
    add: (name: string) => {
      this.className = `${this.className} ${name}`.trim()
    },
    contains: (name: string) => this.className.split(' ').includes(name),
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value)
  }
  append(...nodes: (FakeNode | string)[]) {
    for (const node of nodes) this.insert(node, this.childNodes.length)
  }
  prepend(...nodes: (FakeNode | string)[]) {
    for (const [index, node] of nodes.entries()) this.insert(node, index)
  }
  replaceChildren(...nodes: (FakeNode | string)[]) {
    for (const child of [...this.childNodes]) child.remove()
    this.append(...nodes)
  }
  get firstElementChild(): FakeElement | null {
    return (this.childNodes.find(node => node instanceof FakeElement) as FakeElement | undefined) ?? null
  }
  override get text(): string {
    return this.childNodes.map(node => node.text).join('')
  }
  all(where: (element: FakeElement) => boolean): FakeElement[] {
    const children = this.childNodes.filter((node): node is FakeElement => node instanceof FakeElement)
    return children.flatMap(child => [...(where(child) ? [child] : []), ...child.all(where)])
  }
  private insert(node: FakeNode | string, index: number) {
    const child = typeof node === 'string' ? new FakeText(node) : node
    child.remove()
    child.parent = this
    this.childNodes.splice(index, 0, child)
  }
}

export class FakeInput extends FakeElement {
  type = ''
  placeholder = ''
  value = ''
  oninput: (() => void) | null = null
}

/** Puts the stand-in in place of the DOM; the returned function takes it away, for the test files that run without one. */
export function useFakeDom(): () => void {
  Object.assign(globalThis, {
    document: { createElement: (tag: string) => (tag === 'input' ? new FakeInput(tag) : new FakeElement(tag)) },
    HTMLInputElement: FakeInput,
  })
  return () => {
    Reflect.deleteProperty(globalThis, 'document')
    Reflect.deleteProperty(globalThis, 'HTMLInputElement')
  }
}
