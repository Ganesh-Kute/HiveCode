import { languageFor } from './packages/icr-merge/icr.js';
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

const lang = languageFor('a.js');
const uB = lang.units(jsBase).find(u => u.key === 'fn:processTradeSocketStream' || u.key === 'decl:processTradeSocketStream');
const uF = lang.units(jsFeat).find(u => u.key === 'fn:processTradeSocketStream' || u.key === 'decl:processTradeSocketStream');

console.log('uB key:', uB.key);
console.log('uB text:', JSON.stringify(uB.text));
console.log('uF text:', JSON.stringify(uF.text));
console.log('EQUAL?', uB.text === uF.text);
