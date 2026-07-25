import { merge } from './packages/icr-merge/index.js'
const base = 'export function oldName() {\n  return "old"\n}\n'
const ours = 'export function newName() {\n  return "old"\n}\n'
const theirs = 'export function oldName() {\n  return "new_impl"\n}\n'
const r = merge(base, ours, theirs, { filename: 'refactor.js' })
console.log(r)
