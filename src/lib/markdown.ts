/**
 * Markdown to outline.
 *
 * This is not a markdown renderer — rows hold plain text, so the job is only
 * to recover *structure*. Two things carry nesting in a markdown document and
 * both are honoured: heading level, and list indentation. Inline syntax is
 * left exactly as written, because the row stores what you see.
 */

export interface ParsedNode {
  text: string
  children: ParsedNode[]
}

const HEADING = /^(#{1,6})\s+(.*)$/
const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/
const THEMATIC_BREAK = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/
const LEADING_SPACE = /^\s*/
/** Fenced code: the fence lines are noise, the contents are kept verbatim. */
const FENCE = /^\s*(?:```|~~~)/

const TAB_WIDTH = 4

export function parseMarkdown(source: string): ParsedNode[] {
  const roots: ParsedNode[] = []
  /** Open headings, outermost first. A heading owns everything under it. */
  const headings: Array<{ level: number; node: ParsedNode }> = []
  /** Open list items, by indent width, reset whenever a heading appears. */
  const items: Array<{ indent: number; node: ParsedNode }> = []
  let inFence = false

  const attach = (parent: ParsedNode | undefined, node: ParsedNode): void => {
    if (parent === undefined) roots.push(node)
    else parent.children.push(node)
  }

  for (const raw of source.split(/\r\n|\r|\n/)) {
    if (FENCE.test(raw)) {
      inFence = !inFence
      continue
    }

    if (!inFence) {
      if (raw.trim() === '') continue
      if (THEMATIC_BREAK.test(raw)) continue

      const heading = HEADING.exec(raw)
      if (heading !== null) {
        const level = (heading[1] ?? '').length
        while (
          headings.length > 0 &&
          (headings[headings.length - 1]?.level ?? 0) >= level
        ) {
          headings.pop()
        }
        const node: ParsedNode = { text: (heading[2] ?? '').trim(), children: [] }
        attach(headings[headings.length - 1]?.node, node)
        headings.push({ level, node })
        // List nesting is relative to its heading, so it starts over here.
        items.length = 0
        continue
      }
    }

    const listItem = inFence ? null : LIST_ITEM.exec(raw)
    const indentText =
      listItem !== null ? (listItem[1] ?? '') : (LEADING_SPACE.exec(raw)?.[0] ?? '')
    const indent = widthOf(indentText)
    const text = listItem !== null ? (listItem[2] ?? '').trim() : raw.trim()
    if (text === '') continue

    while (items.length > 0 && (items[items.length - 1]?.indent ?? 0) >= indent) {
      items.pop()
    }
    const parent =
      items[items.length - 1]?.node ?? headings[headings.length - 1]?.node
    const node: ParsedNode = { text, children: [] }
    attach(parent, node)
    items.push({ indent, node })
  }

  return roots
}

function widthOf(indent: string): number {
  let width = 0
  for (const character of indent) {
    width += character === '\t' ? TAB_WIDTH : 1
  }
  return width
}

/** Total nodes in a parsed forest, for reporting what an import will add. */
export function countNodes(nodes: readonly ParsedNode[]): number {
  return nodes.reduce((total, node) => total + 1 + countNodes(node.children), 0)
}
