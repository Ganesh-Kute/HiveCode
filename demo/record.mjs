#!/usr/bin/env node
/**
 * RECORD THE SCORECARD AS A VIDEO — fully automatic, no OBS, no desktop capture.
 *
 * Why not screen capture: gdigrab records whatever is on the monitor, depends on window
 * focus and display scaling, and can silently capture a black or occluded window. That is
 * the failure mode that wasted a take last time. This instead records the REAL run's
 * stdout with real timestamps, then renders the terminal itself, so the output is
 * byte-identical to `npm run scorecard` and reproducible on any machine.
 *
 *   node demo/record.mjs              # both videos
 *   node demo/record.mjs --keep       # also keep the PNG frames
 *
 * Produces, in demo/:
 *   scorecard-cast.json    the raw timed capture (source of truth)
 *   scorecard-full.mp4     REAL timing, nothing cut       <- use this one for claims
 *   scorecard-short.mp4    idle gaps capped at 1.2s       <- watchable, and say so
 */
import { spawn, spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { wrap, COLS } from './wrap.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const FRAMES = path.join(HERE, 'frames')
const KEEP = process.argv.includes('--keep')

// ── locate magick + ffmpeg ────────────────────────────────────────────────────
const CANDIDATES = [
  process.env.MAGICK_DIR,
  'C:/Program Files/ImageMagick-7.1.0-Q16-HDRI',
  'C:/Program Files/ImageMagick-7.1.1-Q16-HDRI',
].filter(Boolean)
function findTool(name) {
  const probe = spawnSync(name, ['-version'], { encoding: 'utf8' })
  if (!probe.error) return name
  for (const d of CANDIDATES) {
    const p = path.join(d, name + '.exe')
    if (fs.existsSync(p)) return p
  }
  return null
}
const MAGICK = findTool('magick')
const FFMPEG = findTool('ffmpeg')
if (!MAGICK || !FFMPEG) {
  console.error('Need ImageMagick (magick) and ffmpeg.')
  console.error('  magick: ' + (MAGICK || 'NOT FOUND') + '\n  ffmpeg: ' + (FFMPEG || 'NOT FOUND'))
  console.error('Set MAGICK_DIR to the ImageMagick install folder if it lives elsewhere.')
  process.exit(2)
}

// ── screen model ──────────────────────────────────────────────────────────────
const W = 1280, H = 720
const PT = 16, LINE = 22, LEFT = 20, TOP = 30
const ROWS = Math.floor((H - TOP) / LINE)      // visible lines
const C = {
  base: '#d4d4d4',
  pass: '#4ec9b0',
  fail: '#f14c4c',
  gap: '#dcdcaa',
  head: '#569cd6',
  dim: '#7a7a7a',
  detail: '#9d9d9d',
}
function colorFor(line) {
  const t = line.trim()
  if (!t) return C.base
  if (t.startsWith('PASS')) return C.pass
  if (t.startsWith('FAIL')) return C.fail
  if (t.startsWith('GAP')) return C.gap
  if (t.startsWith('#')) return C.head
  if (t.startsWith('=====') || t.startsWith('SCORECARD')) return C.dim
  if (t.startsWith('[')) {
    if (t.includes('PASS')) return C.pass
    if (t.includes('FAIL')) return C.fail
    if (t.includes('GAP')) return C.gap
  }
  if (line.startsWith('        ')) return C.detail
  return C.base
}

// ── 1. record the real run ────────────────────────────────────────────────────
console.log('recording: node scorecard.mjs   (real run, ~75s)')
const events = []
const t0 = Date.now()
const child = spawn(process.execPath, ['scorecard.mjs'], {
  cwd: ROOT,
  env: { ...process.env, FORCE_COLOR: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
const onData = (d) => {
  const text = String(d)
  events.push([(Date.now() - t0) / 1000, text])
  process.stdout.write(text)
}
child.stdout.on('data', onData)
child.stderr.on('data', onData)
const exitCode = await new Promise((r) => child.on('close', r))

fs.mkdirSync(HERE, { recursive: true })
fs.writeFileSync(path.join(HERE, 'scorecard-cast.json'),
  JSON.stringify({ width: W, height: H, cols: COLS, rows: ROWS, exitCode, events }, null, 1))
console.log('\ncast written: demo/scorecard-cast.json  (' + events.length + ' events, exit ' + exitCode + ')')

// ── 2. replay into frames ─────────────────────────────────────────────────────
fs.rmSync(FRAMES, { recursive: true, force: true })
fs.mkdirSync(FRAMES, { recursive: true })

let buf = ''
const frames = []   // {lines, at}
for (const [at, text] of events) {
  buf += text
  const all = buf.split('\n').flatMap(wrap)
  const lines = all.slice(Math.max(0, all.length - ROWS))
  frames.push({ at, lines })
}
// collapse consecutive frames whose visible screen is identical
const uniq = []
for (const f of frames) {
  const key = f.lines.join('\n')
  if (uniq.length && uniq[uniq.length - 1].key === key) continue
  uniq.push({ ...f, key })
}
console.log('rendering ' + uniq.length + ' unique frames...')

// '%' would be read as an ImageMagick format escape and a leading '@' as "read from file".
const sanitize = (s) => s.replace(/%/g, 'pct').replace(/\t/g, '    ').replace(/^@/, ' @')
uniq.forEach((f, i) => {
  const args = ['-size', W + 'x' + H, 'xc:#0c0c0c', '-type', 'TrueColor',
    '-font', 'Consolas', '-pointsize', String(PT)]
  f.lines.forEach((line, r) => {
    const txt = sanitize(line)
    if (!txt.trim()) return
    args.push('-fill', colorFor(line), '-annotate', '+' + LEFT + '+' + (TOP + r * LINE), txt)
  })
  const out = path.join(FRAMES, 'f' + String(i).padStart(4, '0') + '.png')
  args.push(out)
  const r = spawnSync(MAGICK, args, { encoding: 'utf8' })
  if (r.status !== 0) { console.error('magick failed on frame ' + i + ': ' + (r.stderr || '').slice(0, 300)); process.exit(1) }
  f.file = out
  if ((i + 1) % 10 === 0) process.stdout.write('  ' + (i + 1) + '/' + uniq.length + '\r')
})
console.log('  ' + uniq.length + '/' + uniq.length + ' frames rendered')

// ── 3. encode ─────────────────────────────────────────────────────────────────
const HOLD = 3.5
function encode(outName, capGap) {
  const lines = []
  for (let i = 0; i < uniq.length; i++) {
    let d = (i + 1 < uniq.length ? uniq[i + 1].at - uniq[i].at : HOLD)
    if (!(d > 0)) d = 0.08
    if (capGap && d > capGap) d = capGap
    lines.push("file '" + path.basename(uniq[i].file) + "'")
    lines.push('duration ' + d.toFixed(3))
  }
  lines.push("file '" + path.basename(uniq[uniq.length - 1].file) + "'")
  const listPath = path.join(FRAMES, 'list.txt')
  fs.writeFileSync(listPath, lines.join('\n') + '\n')
  const out = path.join(HERE, outName)
  const r = spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0',
    '-i', 'list.txt', '-vsync', 'vfr', '-r', '15', '-pix_fmt', 'yuv420p',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-movflags', '+faststart', out],
    { cwd: FRAMES, encoding: 'utf8' })
  if (r.status !== 0) { console.error('ffmpeg failed: ' + (r.stderr || '').slice(0, 400)); return null }
  const probe = spawnSync(FFMPEG, ['-hide_banner', '-i', out], { encoding: 'utf8' })
  const dur = ((probe.stderr || '').match(/Duration: ([0-9:.]+)/) || [])[1] || '?'
  const kb = Math.round(fs.statSync(out).size / 1024)
  console.log('  ' + outName.padEnd(22) + dur + '   ' + kb + ' KB')
  return out
}
console.log('\nencoding:')
encode('scorecard-full.mp4', 0)
encode('scorecard-short.mp4', 1.2)

if (!KEEP) fs.rmSync(FRAMES, { recursive: true, force: true })
else console.log('\nframes kept in demo/frames/')

console.log('\nscorecard-full.mp4  = REAL timing, nothing cut. Use this when you make a claim.')
console.log('scorecard-short.mp4 = same run, waiting time capped at 1.2s. Say "waits trimmed".')
console.log('The run itself exited ' + exitCode + (exitCode === 0 ? ' (no failures)' : ' (A CHECK FAILED)'))
process.exit(0)
