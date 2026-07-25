import { javascript } from './packages/icr-merge/lang-js.js';
import fs from 'fs';

const jsBase = `import { useState, useEffect } from 'react';

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

const jsArch = jsBase.replace(
  'export async function processTradeSocketStream',
  '// [ARCHITECT] Renamed to match new SOC2 naming conventions\\nexport async function initializeSecureWebSocket'
).replace(
  "processTradeSocketStream('init-001')",
  "initializeSecureWebSocket('init-001')"
);

const jsFeat = jsBase.replace(
  '    return "Dashboard Active";\\n}',
  `    
    // [FEATURE] Added multiple new telemetry hooks calling the core stream
    useEffect(() => {
        processTradeSocketStream('telemetry-002').then(data => console.log(data));
        processTradeSocketStream('risk-003').then(data => console.log(data));
        processTradeSocketStream('audit-004').then(data => console.log(data));
    }, []);

    return "Dashboard Active";
}`
);

console.log('Base parses:', javascript.parses(jsBase));
console.log('Arch parses:', javascript.parses(jsArch));
console.log('Feat parses:', javascript.parses(jsFeat));
