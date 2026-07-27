// Pricing seat selector + Razorpay checkout.
//
// Every price and seat number comes from shared/license.js, which the serverless
// functions import too, so the browser cannot drift from the API again.
//
// The browser NO LONGER MINTS A KEY. It used to build `HC-PRO-<seats>-<paymentId>` in a
// handler and show it in an alert(), which meant the key was never recorded server-side
// (so the relay could not check it, and anyone could type an equivalent string) and was
// lost forever if the dialog was dismissed. Now the webhook issues and stores the key,
// emails it, and this page polls /api/license to display it as soon as it exists.

import {
  PLANS,
  amountInMinorUnits,
  clampSeats,
  monthlyTotal,
} from '../../shared/license.js'
import { EDITOR_STEPS } from '../../shared/onboarding.js'

interface RazorpayFailure {
  readonly error?: { readonly description?: string }
}

interface RazorpaySuccess {
  readonly razorpay_payment_id: string
}

interface RazorpayOptions {
  key: string
  amount: number
  currency: string
  name: string
  description: string
  image?: string
  handler: (response: RazorpaySuccess) => void
  prefill?: { name?: string; email?: string; contact?: string }
  notes?: Record<string, string>
  theme?: { color?: string }
}

interface RazorpayInstance {
  open(): void
  on(event: 'payment.failed', handler: (response: RazorpayFailure) => void): void
}

declare const Razorpay: undefined | (new (options: RazorpayOptions) => RazorpayInstance)

const PRO = PLANS.pro

/** How long to wait for the webhook to land before falling back to "check your email". */
const POLL_ATTEMPTS = 12
const POLL_INTERVAL_MS = 2500

interface Dialog {
  open(title: string, body: string): void
  setBody(body: string): void
  showKey(key: string): void
  showSteps(): void
  showRecovery(paymentId: string): void
}

function buildDialog(): Dialog {
  const overlay = document.createElement('div')
  overlay.className = 'modal'
  overlay.hidden = true
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.innerHTML = `
    <div class="modal__card" role="document">
      <h3 class="modal__title" data-modal-title></h3>
      <p class="modal__body" data-modal-body></p>
      <div class="modal__key" data-modal-key hidden>
        <code data-modal-key-text></code>
        <button type="button" class="btn btn--ghost btn--sm" data-modal-copy>Copy</button>
      </div>
      <div class="modal__next" data-modal-steps hidden></div>
      <a class="modal__more" data-modal-recover hidden></a>
      <button type="button" class="btn btn--primary modal__close" data-modal-close>Done</button>
    </div>`
  document.body.appendChild(overlay)

  const titleEl = overlay.querySelector<HTMLElement>('[data-modal-title]')!
  const bodyEl = overlay.querySelector<HTMLElement>('[data-modal-body]')!
  const keyWrap = overlay.querySelector<HTMLElement>('[data-modal-key]')!
  const keyText = overlay.querySelector<HTMLElement>('[data-modal-key-text]')!
  const stepsWrap = overlay.querySelector<HTMLElement>('[data-modal-steps]')!
  const recoverLink = overlay.querySelector<HTMLAnchorElement>('[data-modal-recover]')!
  const copyBtn = overlay.querySelector<HTMLButtonElement>('[data-modal-copy]')!
  const closeBtn = overlay.querySelector<HTMLButtonElement>('[data-modal-close]')!

  let lastFocused: HTMLElement | null = null

  function close(): void {
    overlay.hidden = true
    document.body.classList.remove('is-locked')
    lastFocused?.focus()
  }

  closeBtn.addEventListener('click', close)
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close()
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !overlay.hidden) close()
  })
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(keyText.textContent ?? '')
      copyBtn.textContent = 'Copied'
      window.setTimeout(() => (copyBtn.textContent = 'Copy'), 1600)
    } catch {
      copyBtn.textContent = 'Select and copy'
    }
  })

  return {
    open(title, body) {
      lastFocused = document.activeElement as HTMLElement | null
      titleEl.textContent = title
      bodyEl.textContent = body
      keyWrap.hidden = true
      stepsWrap.hidden = true
      recoverLink.hidden = true
      overlay.hidden = false
      document.body.classList.add('is-locked')
      closeBtn.focus()
    },
    setBody(body) {
      bodyEl.textContent = body
    },
    showKey(key) {
      keyText.textContent = key
      keyWrap.hidden = false
    },
    // A compact form of the same four steps the page and the email carry, because this is
    // the one moment we know the buyer is looking. Titles and literals only — the prose
    // version is a scroll away, and a wall of text here would be skipped.
    showSteps() {
      if (!stepsWrap.childElementCount) {
        const head = document.createElement('p')
        head.className = 'modal__nextTitle'
        head.textContent = 'Then, four steps to your first room'
        stepsWrap.appendChild(head)

        const list = document.createElement('ol')
        list.className = 'setup setup--tight'
        // The editor route only. An agents-only customer has a shorter path that does not
        // involve VS Code at all, and it is one link away rather than crammed in here.
        for (const step of EDITOR_STEPS) {
          const item = document.createElement('li')
          item.className = 'setup__row'

          const title = document.createElement('p')
          title.className = 'setup__t'
          title.textContent = step.title
          item.appendChild(title)

          if (step.literal) {
            const lit = document.createElement('code')
            lit.className = 'setup__lit'
            lit.textContent = step.literal
            item.appendChild(lit)
          }
          list.appendChild(item)
        }
        stepsWrap.appendChild(list)

        const more = document.createElement('a')
        more.className = 'modal__more'
        more.href = '#setup'
        more.textContent = 'Running agents without an editor? See both routes →'
        more.addEventListener('click', () => closeBtn.click())
        stepsWrap.appendChild(more)
      }
      stepsWrap.hidden = false
    },
    // Shown only when the key has not arrived in time. Pre-filling the payment id means the
    // customer never has to copy a reference between two places to get their own licence.
    showRecovery(paymentId) {
      recoverLink.href = `/recover?payment_id=${encodeURIComponent(paymentId)}`
      recoverLink.textContent = 'Retrieve it here as soon as it lands →'
      recoverLink.hidden = false
    },
  }
}

/** Ask the API for the key issued against this payment. The webhook may not have arrived
 *  yet, so 404 means "not yet", not "never". */
async function fetchIssuedKey(paymentId: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/license?payment_id=${encodeURIComponent(paymentId)}`)
    if (!res.ok) return null
    const data = (await res.json()) as { found?: boolean; licenseKey?: string }
    return data.found && data.licenseKey ? data.licenseKey : null
  } catch {
    return null
  }
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms))

async function revealKey(dialog: Dialog, paymentId: string, seats: number): Promise<void> {
  const committers = seats === 1 ? '1 committer' : `${seats} committers`
  dialog.open(
    'Payment received',
    `Your Pro licence covers ${committers}. Issuing your key — this usually takes a few seconds.`,
  )

  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    const key = await fetchIssuedKey(paymentId)
    if (key) {
      dialog.setBody(
        `Your Pro licence covers ${committers}. Copy the key below — it is in your inbox too, ` +
          `along with these steps.`,
      )
      dialog.showKey(key)
      dialog.showSteps()
      return
    }
    await wait(POLL_INTERVAL_MS)
  }

  // Still nothing: the payment is safe and recorded, the key just has not been issued yet.
  // Give them the payment id so support (or /api/license) can recover it — and still show
  // the steps, because step 1 needs no key and the key is arriving by email.
  dialog.setBody(
    `Your payment went through and your licence for ${committers} is being issued. Your payment ` +
      `reference is ${paymentId} — keep it, it is all you need to claim the key.`,
  )
  dialog.showRecovery(paymentId)
  dialog.showSteps()
}

export function mountCheckout(root: HTMLElement): void {
  const slider = root.querySelector<HTMLInputElement>('[data-seats-input]')
  const seatsOut = root.querySelector<HTMLElement>('[data-seats-value]')
  const totalOut = root.querySelector<HTMLElement>('[data-seats-total]')
  const featOut = root.querySelector<HTMLElement>('[data-seats-feature]')
  const payBtn = root.querySelector<HTMLButtonElement>('[data-checkout]')
  if (!slider || !payBtn) return
  // Re-bind past the guard: the helpers below are hoisted declarations and do not inherit
  // the narrowing above.
  const input: HTMLInputElement = slider

  input.min = String(PRO.minSeats)
  input.max = String(PRO.maxSeats)

  const dialog = buildDialog()
  const razorpayKey = payBtn.dataset.razorpayKey ?? ''

  function seats(): number {
    return clampSeats(PRO, Number.parseInt(input.value, 10))
  }

  function paint(): void {
    const n = seats()
    if (seatsOut) seatsOut.textContent = String(n)
    if (totalOut) totalOut.textContent = String(monthlyTotal(PRO, n))
    if (featOut) featOut.textContent = n === 1 ? '1 active committer' : `${n} active committers`
    input.setAttribute('aria-valuetext', n === 1 ? '1 committer' : `${n} committers`)
  }

  input.addEventListener('input', paint)
  paint()

  payBtn.addEventListener('click', (event) => {
    event.preventDefault()
    const n = seats()

    if (typeof Razorpay !== 'function') {
      dialog.open(
        'Checkout unavailable',
        'The payment library did not load — check your connection or ad blocker and try again.',
      )
      return
    }

    const checkout = new Razorpay({
      key: razorpayKey,
      amount: amountInMinorUnits(PRO, n),
      currency: 'USD',
      name: 'Hivecode Pro',
      description: n === 1 ? '1 active committer' : `${n} active committers`,
      image: '/mark-64.png',
      // The webhook reads seats from here, so this is what the licence is issued for.
      notes: { plan: PRO.id, seats: String(n) },
      theme: { color: '#35C9F0' },
      handler(response) {
        void revealKey(dialog, response.razorpay_payment_id, n)
      },
    })

    checkout.on('payment.failed', (response) => {
      dialog.open(
        'Payment failed',
        response.error?.description ?? 'The payment could not be completed. Nothing was charged.',
      )
    })

    checkout.open()
  })
}
