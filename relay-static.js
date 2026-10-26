import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const STATIC = {
  '/': 'index.html', '/index.html': 'index.html',
  '/control': 'control.html', '/control.html': 'control.html',
  // The live architecture map. Same CRDT bundle as /control, so it must be served from the
  // same origin -- a page that loads hive-crdt.js from anywhere else gets two Yjs instances
  // and goes silently deaf.
  '/map': 'map.html', '/map.html': 'map.html',
  // Licence recovery. The page calls Vercel's /api/license directly (CORS is open for
  // exactly this), so it works served from here even though this host has no such route.
  '/recover': 'recover.html', '/recover.html': 'recover.html',
  '/app.js': 'app.js',
  // The control room's CRDT bundle. Without this entry /control loads and then cannot
  // sync at all on this host, while working fine on Vercel.
  '/hive-crdt.js': 'hive-crdt.js',
  '/hive-time.js': '../hive-time.js',
  '/favicon.ico': 'favicon.ico',
  '/favicon-32.png': 'favicon-32.png',
  '/apple-touch-icon.png': 'apple-touch-icon.png',
  '/mark-64.png': 'mark-64.png',
  '/mark.jpg': 'mark.jpg',
  '/mark-wide.jpg': 'mark-wide.jpg',
  '/hivecode-logo.png': 'hivecode-logo.png',
  '/hivecode-icr-demo.mp4': 'hivecode-icr-demo.mp4',
  '/Hivecode___ICR.mp4': 'Hivecode___ICR.mp4'
}

export function staticFile(target, baseDir = __dirname) {
  if (!target) return null
  return target.startsWith('../')
    ? path.join(baseDir, target.slice(3))
    : path.join(baseDir, 'public', target)
}
