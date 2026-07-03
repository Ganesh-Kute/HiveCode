// substrate.js — the Hivecode convergent semantic substrate.
//
// This is the primitive the whole project has been building toward. It is NOT a
// connection protocol (that is MCP / A2A — a wire that carries messages). It is a
// MEDIUM: a shared state that agents write into, where the medium itself enforces
// guarantees no channel can. Coordination is a property of the medium, not of a
// controller.
//
// The unit of exchange is not a message or a tool call — it is a CHANGE: a triple
//     (intent, patch, provenance)
// published against the medium's current state. On every publish the medium enforces
// three invariants, and refuses the change if any fails:
//
//   I1  PROVENANCE-VERIFIED — every accepted byte traces to a cryptographically
//       verified author and a DECLARED intent, chained to the state it built on.
//       A forged, unsigned, or mis-attributed change is rejected. (This is the new
//       part — no CRDT, no git, no MCP carries verifiable per-change provenance.)
//
//   I2  CONVERGENT — merging is deterministic and symmetric (ICR guarantees this),
//       so any number of agents applying the same set of changes in ANY order reach
//       the exact same state. No divergence, no "last writer wins" corruption.
//
//   I3  NON-REGRESSING — the medium only ever moves to an equal-or-healthier state.
//       A change that would make the code parse worse than it already does (or that
//       silently clobbers another agent's edit) is refused, not landed. The shared
//       state can never become more broken than it was.
//
// Everything language-specific (parse, structural merge, intent detection) is
// delegated to ICR (icr.js). Everything identity-specific (self-certifying keys,
// fingerprints) reuses the crypto model already proven in token.js. This file adds
// only the missing layer: provenance as a first-class, verifiable, chained TYPE on
// every change — the thing that turns "merge + coordinate" into a governed medium.

import crypto from 'crypto'
import { structuralMerge, supports, parses, languageFor } from './icr.js'
import { keyFingerprint } from './token.js'

// --- hashing / canonical encoding ----------------------------------------------
// A content hash names a state. Two identical texts hash identically on every peer,
// so a hash is a stable, portable pointer into the provenance DAG.
const sha = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('base64url')

export const contentHash = (text) => sha(text == null ? '' : text)
export const GENESIS = 'genesis' // the parent of the very first change into an empty medium

// The exact bytes a change's signature commits to. Fixed field order (NOT JSON, whose
// key order is not guaranteed) so the signed message is identical on every peer. The
// signature binds WHO (author) + on-top-of-WHAT (parent) + WHY (intent) + WHAT
// (contentHash of the patch text) + WHEN (at). Change any one and the signature breaks.
function signingMessage(p) {
  return [p.author, p.parent, p.intent || '', p.contentHash, p.at].join('\n')
}

// --- identity: self-certifying keypairs (Ed25519) ------------------------------
// An author IS the fingerprint of their public key (same anchoring token.js uses for
// secured rooms). You cannot claim to be another agent's id without their private key,
// and no key registry is needed — the key travels with the change and certifies itself.
export function genIdentity(name = '') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const pk = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const sk = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  return { name, pk, sk, id: keyFingerprint(pk) }
}

// --- authoring: turn a raw edit into a signed, provenance-typed CHANGE ----------
// `identity` is {pk, sk, id} from genIdentity (or a wrapped key). `base` is the text
// the agent edited FROM (its known ancestor); `text` is the result. `intent` is the
// declared reason (carried, verified, and used by ICR's semantic merge).
export function authorChange({ identity, filename, base, text, intent = '', at }) {
  if (at == null) throw new Error('authorChange: `at` is required (pass a timestamp; the substrate never reads the clock itself so it stays deterministic/replayable)')
  const cHash = contentHash(text)
  const prov = {
    author: identity.id,
    pk: identity.pk,
    parent: contentHash(base), // the state this change was made against
    intent: String(intent || ''),
    contentHash: cHash,
    at,
  }
  const sig = crypto.sign(null, Buffer.from(signingMessage(prov)), crypto.createPrivateKey(identity.sk))
  prov.sig = sig.toString('base64url')
  return { filename, base, text, intent: prov.intent, prov }
}

// --- I1: verify a change's provenance ------------------------------------------
// Returns { ok, reason }. Checks, in order: the signature is valid for the carried
// public key; the author id is the fingerprint of that key (no impersonation); and
// the signed contentHash actually matches the patch text (no swapping the body after
// signing). A change that fails any of these is not trusted and is never applied.
export function verifyProvenance(change) {
  const p = change && change.prov
  if (!p || !p.author || !p.pk || !p.sig || !p.contentHash) return { ok: false, reason: 'missing provenance' }
  if (keyFingerprint(p.pk) !== p.author) return { ok: false, reason: 'author id does not match public key (impersonation)' }
  if (contentHash(change.text) !== p.contentHash) return { ok: false, reason: 'content hash does not match text (tampered body)' }
  let valid = false
  try { valid = crypto.verify(null, Buffer.from(signingMessage(p)), crypto.createPublicKey(p.pk), Buffer.from(p.sig, 'base64url')) }
  catch { valid = false }
  if (!valid) return { ok: false, reason: 'bad signature (forged or altered provenance)' }
  return { ok: true }
}

// --- parse health: the metric non-regression is defined against -----------------
// 0 = parses; 1 = does not. (A coarse but honest, language-agnostic health score:
// the medium refuses to move from a parsing state to a non-parsing one.) For an
// unsupported language ICR can't judge structure, so we treat it as always-healthy
// and fall back to last-writer semantics — provenance still applies.
function health(text, filename) {
  if (!supports(filename)) return 0
  return parses(text, languageFor(filename)) ? 0 : 1
}
// Exported for the relay's content-authority check (non-regression on the head).
export function contentHealth(text, filename) { return health(text, filename) }

// --- authoritative head: validate the attested "current content" of a file ------
// A head is { text, hash, at, by?, receipt }. It is internally valid iff its receipt
// is a genuine signed provenance record AND it actually attests THIS text (hash ties
// the receipt to the content). This is the structural half of content authority; the
// relay adds non-regression (contentHealth) on top so the current content of a file is
// always both verified AND no more broken than it was.
export function headOk(head) {
  if (!head || !head.receipt || typeof head.text !== 'string') return { ok: false, reason: 'malformed head' }
  const h = contentHash(head.text)
  if (head.hash !== h) return { ok: false, reason: 'head.hash does not match head.text' }
  if (head.receipt.contentHash !== h) return { ok: false, reason: 'receipt does not attest this text' }
  const v = verifyReceipt(head.receipt)
  if (!v.ok) return { ok: false, reason: v.reason }
  return { ok: true }
}

// --- an empty medium ------------------------------------------------------------
export function emptyState() {
  return { text: null, hash: null, history: [] } // history = the provenance DAG (append-only)
}

// --- publish: the one operation, enforcing all three invariants -----------------
// publish(state, change) -> { accepted, state, receipt, reason }
//   accepted:false  -> the change is REFUSED; `state` is returned UNCHANGED (the medium
//                      never regresses), `reason` says which invariant stopped it.
//   accepted:true   -> `state` is the new state; `receipt` is the DAG node just linked.
//
// The function is PURE: same (state, change) -> same result on every peer. It reads no
// clock and no randomness (timestamps live in the signed change), so a peer can replay
// a change log and reach byte-identical state — the operational meaning of "convergent".
export function publish(state, change) {
  state = state || emptyState()

  // I1 — PROVENANCE. Refuse anything we can't attribute to a verified author + intent.
  const v = verifyProvenance(change)
  if (!v.ok) return { accepted: false, state, reason: 'I1 provenance: ' + v.reason }

  const filename = change.filename || 'x.js'

  // GENESIS — first change into an empty medium. Accept iff it is itself healthy; there
  // is nothing to merge against, so convergence/non-regression are trivially satisfied.
  if (state.text == null) {
    if (health(change.text, filename) > 0) return { accepted: false, state, reason: 'I3 non-regression: genesis change does not parse' }
    return commit(state, change, change.text, filename, 'genesis')
  }

  // FIXED POINT — the change reproduces the current state exactly. Nothing to do; the
  // medium is already there. (Keeps re-publishes and echoes idempotent.)
  if (change.text === state.text) return commit(state, change, state.text, filename, 'noop')

  // I2 — CONVERGENCE via ICR's deterministic, symmetric 3-way merge:
  //   base = the ancestor the change was authored against; a = the medium's current
  //   text; b = the incoming change. ICR guarantees the merge is order-independent, so
  //   two peers merging the same changes converge on identical bytes.
  const merged = structuralMerge(change.base, state.text, change.text, { filename, authors: { a: 'medium', b: change.prov.author } })

  // I3 — NON-REGRESSION. Only 'auto' (a clean, parseable merge) may move the medium.
  //   'semantic-conflict' — the change collides with the current state on the SAME unit;
  //                         landing it would clobber another agent's edit. Refuse; the
  //                         author must reconcile against the new parent and re-publish.
  //   'fallback'          — the merge would not parse / inputs unparseable. Refuse rather
  //                         than let the shared state become more broken than it is.
  if (merged.status !== 'auto') {
    const reason = merged.status === 'semantic-conflict'
      ? `I3 non-regression: semantic conflict on ${(merged.conflicts || []).join(', ') || 'a shared unit'} — reconcile against parent ${state.hash} and re-publish`
      : `I3 non-regression: merge would not produce healthy code (${merged.reason || 'fallback'})`
    return { accepted: false, state, reason, conflicts: merged.conflicts || [] }
  }
  // Defense in depth: the merged text must be at least as healthy as the current state.
  if (health(merged.text, filename) > health(state.text, filename))
    return { accepted: false, state, reason: 'I3 non-regression: merged result parses worse than current state' }

  return commit(state, change, merged.text, filename, 'merge', merged)
}

// Link an accepted change into the provenance DAG and advance the state. The receipt is
// the audit record: it records the author/intent/parent from the signed change, the hash
// the medium actually arrived at, and how (genesis | noop | merge). The chain of receipts
// is independently verifiable end-to-end via verifyChain().
function commit(state, change, newText, filename, how, merged) {
  const receipt = {
    author: change.prov.author,
    intent: change.prov.intent,
    parent: change.prov.parent,       // what the author built on
    prevHash: state.hash || GENESIS,  // the medium's state just before this commit
    contentHash: change.prov.contentHash,
    resultHash: contentHash(newText), // the hash the medium arrived at
    at: change.prov.at,
    sig: change.prov.sig,
    pk: change.prov.pk,
    how,
    ...(merged && merged.renames && merged.renames.length ? { renames: merged.renames } : {}),
    ...(merged && merged.provenance ? { units: merged.provenance } : {}),
  }
  return {
    accepted: true,
    receipt,
    state: { text: newText, hash: receipt.resultHash, history: [...state.history, receipt] },
  }
}

// --- audit: verify ONE receipt in isolation -------------------------------------
// A receipt is a flattened, self-contained provenance record (as stored in the live
// shared ledger). This proves its integrity WITHOUT the patch text: the signature
// commits to (author, parent, intent, contentHash, at), so a valid signature means
// "this verified author vouched for a change producing state <contentHash> with this
// intent at this time". Used to audit the live ledger, where concurrent writers make
// the history a signed DAG rather than a single line (so verifyChain's linear check
// doesn't apply, but per-receipt provenance still does — every entry is attributable).
export function verifyReceipt(r) {
  if (!r || !r.pk || !r.author || !r.sig || !r.contentHash) return { ok: false, reason: 'missing provenance fields' }
  if (keyFingerprint(r.pk) !== r.author) return { ok: false, reason: 'author id does not match public key' }
  const msg = signingMessage({ author: r.author, parent: r.parent, intent: r.intent, contentHash: r.contentHash, at: r.at })
  let valid = false
  try { valid = crypto.verify(null, Buffer.from(msg), crypto.createPublicKey(r.pk), Buffer.from(r.sig, 'base64url')) } catch { valid = false }
  return valid ? { ok: true } : { ok: false, reason: 'bad signature' }
}

// --- audit: verify an entire provenance DAG end-to-end --------------------------
// Re-checks every receipt's signature and identity, and that the chain is unbroken
// (each commit's prevHash equals the prior commit's resultHash). Returns
// { ok, length, broken? } — a full, independent audit of who authored every state the
// medium ever held. This is what makes "provenance-verified" true for HISTORY, not just
// the latest write: anyone can replay the chain and prove no state was ever unattributed.
export function verifyChain(history) {
  if (!Array.isArray(history)) return { ok: false, reason: 'no history' }
  let prev = GENESIS
  for (let i = 0; i < history.length; i++) {
    const r = history[i]
    if (keyFingerprint(r.pk) !== r.author) return { ok: false, broken: i, reason: 'author id / key mismatch' }
    const msg = signingMessage({ author: r.author, parent: r.parent, intent: r.intent, contentHash: r.contentHash, at: r.at })
    let valid = false
    try { valid = crypto.verify(null, Buffer.from(msg), crypto.createPublicKey(r.pk), Buffer.from(r.sig, 'base64url')) } catch { valid = false }
    if (!valid) return { ok: false, broken: i, reason: 'bad signature' }
    if (r.prevHash !== prev) return { ok: false, broken: i, reason: `chain break: prevHash ${r.prevHash} != ${prev}` }
    prev = r.resultHash
  }
  return { ok: true, length: history.length }
}
