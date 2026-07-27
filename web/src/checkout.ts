// Pricing seat selector + Razorpay checkout.
//
// Every price, seat count, and key string comes from ./license.ts so the browser cannot
// drift from the API again. Payment behaviour itself is unchanged from the previous page:
// same Razorpay options, same amount arithmetic.
//
// KNOWN GAP (deliberately left visible rather than papered over): the key shown after
// payment is still minted in the browser from the payment id. It is well-formed but not
// server-issued, so it proves nothing to the relay. Replacing `mintProvisionalKey` with a
// POST to a server issue-endpoint is the whole fix, and it is the only place to change.

import {
  PLANS,
  amountInMinorUnits,
  clampSeats,
  formatLicenseKey,
  monthlyTotal,
  type LicenseKey,
} from './license.js'

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

function mintProvisionalKey(seats: number, paymentId: string): LicenseKey {
  return { plan: 'pro', seats, token: paymentId.replace(/[^A-Za-z0-9_]/g, '') }
}

interface Dialog {
  open(title: string, body: string, keyText?: string): void
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
      <button type="button" class="btn btn--primary modal__close" data-modal-close>Done</button>
    </div>`
  document.body.appendChild(overlay)

  const titleEl = overlay.querySelector<HTMLElement>('[data-modal-title]')!
  const bodyEl = overlay.querySelector<HTMLElement>('[data-modal-body]')!
  const keyWrap = overlay.querySelector<HTMLElement>('[data-modal-key]')!
  const keyText = overlay.querySelector<HTMLElement>('[data-modal-key-text]')!
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
    open(title, body, key) {
      lastFocused = document.activeElement as HTMLElement | null
      titleEl.textContent = title
      bodyEl.textContent = body
      if (key) {
        keyText.textContent = key
        keyWrap.hidden = false
      } else {
        keyWrap.hidden = true
      }
      overlay.hidden = false
      document.body.classList.add('is-locked')
      closeBtn.focus()
    },
  }
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
      image: '/favicon-32.png',
      notes: { plan: PRO.id, seats: String(n) },
      theme: { color: '#35C9F0' },
      handler(response) {
        const key = formatLicenseKey(mintProvisionalKey(n, response.razorpay_payment_id))
        dialog.open(
          'Payment received',
          `Your Pro licence covers ${n === 1 ? '1 committer' : `${n} committers`}. Save this key — you will paste it into the Hivecode extension or set it as HIVE_LICENSE on a self-hosted relay.`,
          key,
        )
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
