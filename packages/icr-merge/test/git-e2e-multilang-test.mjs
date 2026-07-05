// GIT E2E — MULTI-LANGUAGE. Same real-git flow as git-e2e-test.mjs, across the
// structural-tier languages: Python, TypeScript, Go, Rust, Java. Per language:
//   A) two branches edit DIFFERENT functions -> `git merge` must come out clean
//      with BOTH edits (vanilla git often conflicts or interleaves here)
//   B) two branches edit the SAME function -> a REAL conflict must be raised
//      (never a silent fuse)
import fs from 'fs'; import os from 'os'; import path from 'path'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DRIVER = path.join(HERE, '..', 'bin', 'icr-merge-driver.js').replace(/\\/g, '/')
let pass = 0, fail = 0
const T = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); c ? pass++ : fail++ }

const LANGS = [
  {
    name: 'Python', file: 'app.py',
    base: 'def alpha():\n    return 1\n\n\ndef beta():\n    return 2\n\n\ndef gamma():\n    return 3\n',
    editA: (s) => s.replace('return 1', 'return 111'),
    editB: (s) => s.replace('return 3', 'return 333'),
    clashA: (s) => s.replace('return 2', 'return 222'),
    clashB: (s) => s.replace('return 2', 'return 999'),
    hasA: (s) => s.includes('return 111'), hasB: (s) => s.includes('return 333'),
  },
  {
    name: 'TypeScript', file: 'svc.ts',
    base: 'export function alpha(): number { return 1 }\n\nexport function beta(): number { return 2 }\n\nexport function gamma(): number { return 3 }\n',
    editA: (s) => s.replace('return 1', 'return 111'),
    editB: (s) => s.replace('return 3', 'return 333'),
    clashA: (s) => s.replace('return 2', 'return 222'),
    clashB: (s) => s.replace('return 2', 'return 999'),
    hasA: (s) => s.includes('return 111'), hasB: (s) => s.includes('return 333'),
  },
  {
    name: 'Go', file: 'main.go',
    base: 'package main\n\nfunc Alpha() int { return 1 }\n\nfunc Beta() int { return 2 }\n\nfunc Gamma() int { return 3 }\n',
    editA: (s) => s.replace('return 1', 'return 111'),
    editB: (s) => s.replace('return 3', 'return 333'),
    clashA: (s) => s.replace('return 2', 'return 222'),
    clashB: (s) => s.replace('return 2', 'return 999'),
    hasA: (s) => s.includes('return 111'), hasB: (s) => s.includes('return 333'),
  },
  {
    name: 'Rust', file: 'lib.rs',
    base: 'fn alpha() -> i32 { 1 }\n\nfn beta() -> i32 { 2 }\n\nfn gamma() -> i32 { 3 }\n',
    editA: (s) => s.replace('{ 1 }', '{ 111 }'),
    editB: (s) => s.replace('{ 3 }', '{ 333 }'),
    clashA: (s) => s.replace('{ 2 }', '{ 222 }'),
    clashB: (s) => s.replace('{ 2 }', '{ 999 }'),
    hasA: (s) => s.includes('{ 111 }'), hasB: (s) => s.includes('{ 333 }'),
  },
  {
    name: 'Java', file: 'App.java',
    base: 'class App {\n  int alpha() { return 1; }\n  int beta() { return 2; }\n  int gamma() { return 3; }\n}\n',
    editA: (s) => s.replace('return 1;', 'return 111;'),
    editB: (s) => s.replace('return 3;', 'return 333;'),
    clashA: (s) => s.replace('return 2;', 'return 222;'),
    clashB: (s) => s.replace('return 2;', 'return 999;'),
    hasA: (s) => s.includes('return 111;'), hasB: (s) => s.includes('return 333;'),
  },
]

function repo(file) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icr-ml-'))
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString()
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@t'); git('config', 'user.name', 'T')
  git('config', 'merge.icr.name', 'ICR')
  git('config', 'merge.icr.driver', `node "${DRIVER}" %O %A %B %P`)
  fs.writeFileSync(path.join(dir, '.gitattributes'), `*${path.extname(file)} merge=icr\n`)
  return {
    git,
    write: (c) => fs.writeFileSync(path.join(dir, file), c),
    read: () => fs.readFileSync(path.join(dir, file), 'utf8'),
    merge: (b) => { try { git('merge', '-q', '--no-edit', b); return true } catch { return false } },
  }
}
const markers = (t) => /^<{7} /m.test(t)

for (const L of LANGS) {
  console.log(`\n# ${L.name} (${L.file})`)
  // A) disjoint functions
  {
    const r = repo(L.file)
    r.write(L.base); r.git('add', '.'); r.git('commit', '-qm', 'base')
    r.git('checkout', '-qb', 'other'); r.write(L.editA(L.base)); r.git('commit', '-aqm', 'a')
    r.git('checkout', '-q', 'main'); r.write(L.editB(L.base)); r.git('commit', '-aqm', 'b')
    const ok = r.merge('other')
    const out = r.read()
    T(`different functions: clean merge, both edits kept`, ok && !markers(out) && L.hasA(out) && L.hasB(out))
  }
  // B) same function
  {
    const r = repo(L.file)
    r.write(L.base); r.git('add', '.'); r.git('commit', '-qm', 'base')
    r.git('checkout', '-qb', 'other'); r.write(L.clashA(L.base)); r.git('commit', '-aqm', 'a')
    r.git('checkout', '-q', 'main'); r.write(L.clashB(L.base)); r.git('commit', '-aqm', 'b')
    const ok = r.merge('other')
    const out = r.read()
    const bothVisible = out.includes('222') && out.includes('999')
    T(`same function: real conflict raised, both versions preserved`, !ok && markers(out) && bothVisible)
  }
}

console.log(`\n=== GIT-E2E-MULTILANG: ${fail === 0 ? 'ALL ' + pass + ' PASS' : fail + ' FAILED'} ===`)
process.exit(fail === 0 ? 0 : 1)
