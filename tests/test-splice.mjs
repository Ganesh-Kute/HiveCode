const baseText = `import { useState, useEffect } from 'react';

// Core websocket connection for live market data
export async function processTradeSocketStream(connectionId) {
    console.log(\`Establishing secure WSS stream on port 443: \${connectionId}\`);
    return { status: "secure_connected", id: connectionId };
}

export function LiveMarketDashboard() {
    const [stream, setStream] = useState(null);

    useEffect(() => {
        processTradeSocketStream('init-001').then(setStream);
    }, []);

    return "Dashboard Active";
}`;

const baseUnits = [
  { key: 'import:react', start: 0, end: 44 },
  { key: 'fn:processTradeSocketStream', start: 94, end: 301 },
  { key: 'fn:LiveMarketDashboard', start: 303, end: 512 }
];

const order = ['import:react', 'fn:LiveMarketDashboard'];
const textByKey = new Map([
  ['import:react', `import { useState, useEffect } from 'react';`],
  ['fn:LiveMarketDashboard', `export function LiveMarketDashboard() {
    const [stream, setStream] = useState(null);

    useEffect(() => {
        processTradeSocketStream('init-001').then(setStream);
    }, []);

    return "Dashboard Active";
}`]
]);

function spliceUnits(baseText, baseUnits, order, textByKey) {
  const baseKeySet = new Set(baseUnits.map((u) => u.key))
  const baseByKey = new Map(baseUnits.map((u) => [u.key, u]))
  const orderSet = new Set(order)
  const deleted = baseUnits.filter((u) => !orderSet.has(u.key))
  let out = '', pos = 0
  
  function emitGap(from, to) {
    let cursor = from
    for (const d of deleted) {
      if (d.start >= cursor && d.end <= to) {
        out += baseText.slice(cursor, d.start)
        cursor = d.end
      }
    }
    out += baseText.slice(cursor, to)
  }

  for (const k of order) {
    if (baseKeySet.has(k)) {
      const u = baseByKey.get(k)
      if (u.start >= pos) {
        emitGap(pos, u.start)
        pos = u.end
      }
      out += textByKey.get(k)
    } else {
      out += (out.endsWith('\n') ? '' : '\n') + textByKey.get(k) + '\n'
    }
  }
  if (pos < baseText.length) {
    emitGap(pos, baseText.length)
  }
  return out.replace(/^\n+/, '')
}

console.log(spliceUnits(baseText, baseUnits, order, textByKey));
