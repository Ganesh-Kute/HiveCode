// Entry point for the marketing page. Bundled to public/app.js by `npm run build:web`.

import { mountCheckout } from './checkout.js'
import { mountHeroDemo } from './demo.js'

/** Copy-to-clipboard for the install commands. */
function mountCopyButtons(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
    button.addEventListener('click', async () => {
      const text = button.dataset.copy ?? ''
      const original = button.getAttribute('aria-label') ?? 'Copy command'
      try {
        await navigator.clipboard.writeText(text)
        button.classList.add('is-copied')
        button.setAttribute('aria-label', 'Copied')
        window.setTimeout(() => {
          button.classList.remove('is-copied')
          button.setAttribute('aria-label', original)
        }, 1600)
      } catch {
        // Clipboard blocked (insecure context or denied permission): select the text so the
        // reader can copy it by hand instead of getting silent nothing.
        const code = button.previousElementSibling
        if (code) {
          const range = document.createRange()
          range.selectNodeContents(code)
          window.getSelection()?.removeAllRanges()
          window.getSelection()?.addRange(range)
        }
      }
    })
  }
}

/** Reveal sections as they enter view; a no-op when the reader prefers less motion. */
function mountReveal(): void {
  const targets = document.querySelectorAll<HTMLElement>('[data-reveal]')
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) {
    targets.forEach((node) => node.classList.add('is-shown'))
    return
  }
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        entry.target.classList.add('is-shown')
        observer.unobserve(entry.target)
      }
    },
    { rootMargin: '0px 0px -12% 0px', threshold: 0.08 },
  )
  targets.forEach((node) => observer.observe(node))
}

/** Shrink the nav once the hero is behind us. */
function mountNav(): void {
  const nav = document.querySelector<HTMLElement>('[data-nav]')
  if (!nav) return
  const onScroll = (): void => {
    nav.classList.toggle('is-stuck', window.scrollY > 24)
  }
  onScroll()
  window.addEventListener('scroll', onScroll, { passive: true })
}

function boot(): void {
  const demo = document.querySelector<HTMLElement>('[data-demo]')
  if (demo) mountHeroDemo(demo)
  const pricing = document.querySelector<HTMLElement>('[data-pricing]')
  if (pricing) mountCheckout(pricing)
  mountCopyButtons()
  mountReveal()
  mountNav()
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true })
} else {
  boot()
}
