// The hero demo: a scripted walkthrough of one real phantom regression.
//
// Two agents edit one file concurrently. Agent A renames a function; Agent B adds a call
// to the old name. Git merges without a conflict and ships a crash. ICR sees the rename
// and rewrites B's call site. That contrast IS the product, so it is the hero — not a
// headline about it.

type LineKind = 'plain' | 'dim' | 'add' | 'del' | 'warn' | 'ok'
type Verdict = 'neutral' | 'broken' | 'clean'

interface Line {
  readonly text: string
  readonly kind?: LineKind
}

interface Pane {
  readonly title: string
  readonly badge?: string
  readonly verdict: Verdict
  readonly verdictLabel?: string
  readonly lines: readonly Line[]
}

interface Step {
  readonly tab: string
  readonly caption: string
  readonly panes: readonly Pane[]
}

const BASE: readonly Line[] = [
  { text: 'export function computeTotal(cart) {', kind: 'plain' },
  { text: '  return cart.items.reduce((n, i) => n + i.price, 0)', kind: 'dim' },
  { text: '}', kind: 'plain' },
  { text: '', kind: 'plain' },
  { text: 'const total = computeTotal(cart)', kind: 'plain' },
]

const STEPS: readonly Step[] = [
  {
    tab: 'base',
    caption: 'One file, agreed by both agents. This is the merge base.',
    panes: [{ title: 'cart.js', badge: 'base', verdict: 'neutral', lines: BASE }],
  },
  {
    tab: 'two agents',
    caption: 'Neither agent has seen the other’s work. Both edits are correct on their own.',
    panes: [
      {
        title: 'agent A — rename for clarity',
        badge: 'ours',
        verdict: 'neutral',
        lines: [
          { text: 'export function cartTotal(cart) {', kind: 'add' },
          { text: '  return cart.items.reduce((n, i) => n + i.price, 0)', kind: 'dim' },
          { text: '}', kind: 'plain' },
          { text: '', kind: 'plain' },
          { text: 'const total = cartTotal(cart)', kind: 'add' },
        ],
      },
      {
        title: 'agent B — add checkout path',
        badge: 'theirs',
        verdict: 'neutral',
        lines: [
          { text: 'export function computeTotal(cart) {', kind: 'plain' },
          { text: '  return cart.items.reduce((n, i) => n + i.price, 0)', kind: 'dim' },
          { text: '}', kind: 'plain' },
          { text: '', kind: 'plain' },
          { text: 'export function checkout(items) {', kind: 'add' },
          { text: '  return computeTotal(items)', kind: 'add' },
          { text: '}', kind: 'add' },
        ],
      },
    ],
  },
  {
    tab: 'git merge',
    caption: 'Git compares lines. The two edits never touch the same line, so there is nothing to report.',
    panes: [
      {
        title: 'git merge-file',
        badge: 'no conflict',
        verdict: 'broken',
        verdictLabel: 'merged clean — silently broken',
        lines: [
          { text: 'export function cartTotal(cart) {', kind: 'plain' },
          { text: '  return cart.items.reduce((n, i) => n + i.price, 0)', kind: 'dim' },
          { text: '}', kind: 'plain' },
          { text: '', kind: 'plain' },
          { text: 'export function checkout(items) {', kind: 'plain' },
          { text: '  return computeTotal(items)', kind: 'del' },
          { text: '}', kind: 'plain' },
          { text: '', kind: 'plain' },
          { text: '// it parses. CI passes. review sees no conflict.', kind: 'dim' },
          { text: 'ReferenceError: computeTotal is not defined', kind: 'warn' },
        ],
      },
    ],
  },
  {
    tab: 'hivecode',
    caption: 'ICR merges declarations, not lines — so a vanished name with an identical-bodied twin reads as a rename, and B’s stale call site is rewritten.',
    panes: [
      {
        title: 'merge(base, A, B, { filename: ‘cart.js’ })',
        badge: "method: 'rename'",
        verdict: 'clean',
        verdictLabel: 'renames: [ computeTotal → cartTotal ]',
        lines: [
          { text: 'export function cartTotal(cart) {', kind: 'plain' },
          { text: '  return cart.items.reduce((n, i) => n + i.price, 0)', kind: 'dim' },
          { text: '}', kind: 'plain' },
          { text: '', kind: 'plain' },
          { text: 'export function checkout(items) {', kind: 'plain' },
          { text: '  return cartTotal(items)', kind: 'ok' },
          { text: '}', kind: 'plain' },
          { text: '', kind: 'plain' },
          { text: '// both intents kept. re-parsed before it was allowed to ship.', kind: 'dim' },
        ],
      },
    ],
  },
]

const STEP_MS = 4200

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function renderPane(pane: Pane): HTMLElement {
  const root = el('figure', `pane pane--${pane.verdict}`)

  const head = el('figcaption', 'pane__head')
  head.appendChild(el('span', 'pane__title', pane.title))
  if (pane.badge) head.appendChild(el('span', 'pane__badge', pane.badge))
  root.appendChild(head)

  const code = el('pre', 'pane__code')
  const codeInner = el('code')
  for (const line of pane.lines) {
    const row = el('span', `ln ln--${line.kind ?? 'plain'}`)
    // Zero-width space keeps empty rows at full line-height without faking content.
    row.textContent = line.text === '' ? '​' : line.text
    codeInner.appendChild(row)
  }
  code.appendChild(codeInner)
  root.appendChild(code)

  if (pane.verdictLabel) {
    root.appendChild(el('div', 'pane__verdict', pane.verdictLabel))
  }
  return root
}

export function mountHeroDemo(root: HTMLElement): void {
  const tabsBar = root.querySelector<HTMLElement>('[data-demo-tabs]')
  const stage = root.querySelector<HTMLElement>('[data-demo-stage]')
  const caption = root.querySelector<HTMLElement>('[data-demo-caption]')
  const rail = root.querySelector<HTMLElement>('[data-demo-rail]')
  if (!tabsBar || !stage || !caption) return
  // Re-bind past the guard: `show` is a hoisted declaration, so it does not inherit the
  // narrowing above.
  const stageEl: HTMLElement = stage
  const captionEl: HTMLElement = caption

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  let current = -1
  let timer: number | undefined
  let paused = false

  const tabs = STEPS.map((step, index) => {
    const tab = el('button', 'demo__tab')
    tab.type = 'button'
    tab.textContent = step.tab
    tab.setAttribute('aria-label', `Step ${index + 1}: ${step.tab}`)
    tab.addEventListener('click', () => {
      stop()
      show(index)
    })
    tabsBar.appendChild(tab)
    return tab
  })

  function show(index: number): void {
    if (index === current) return
    current = index
    const step = STEPS[index]
    tabs.forEach((tab, i) => {
      const active = i === index
      tab.classList.toggle('is-active', active)
      tab.setAttribute('aria-current', active ? 'step' : 'false')
    })
    stageEl.replaceChildren(...step.panes.map(renderPane))
    stageEl.classList.toggle('stage--split', step.panes.length > 1)
    captionEl.textContent = step.caption
    if (rail) {
      rail.classList.remove('is-running')
      if (!paused && !reduceMotion) {
        // Restart the CSS transition by forcing a reflow between class toggles.
        void rail.offsetWidth
        rail.classList.add('is-running')
      }
    }
  }

  function advance(): void {
    show((current + 1) % STEPS.length)
    timer = window.setTimeout(advance, STEP_MS)
  }

  function stop(): void {
    paused = true
    if (timer !== undefined) window.clearTimeout(timer)
    timer = undefined
    rail?.classList.remove('is-running')
  }

  show(0)

  if (reduceMotion) {
    paused = true
    return
  }

  root.addEventListener('mouseenter', stop, { once: true })
  root.addEventListener('focusin', stop, { once: true })
  timer = window.setTimeout(advance, STEP_MS)
}
