// Richer negotiation — a lock holder can GRANT, COUNTER, or DENY a request,
// instead of always auto-handing-over. Builds on your lock+ask idea.
//
// The decision logic lives in core.js (negotiate) and is unit-tested; this
// shows the three outcomes as a readable conversation between two agents.

import { negotiate } from './core.js'

function conversation(holder, request) {
  console.log(`\n[holder] working on: "${holder.intent}"${holder.done ? ' (finished)' : ''}`)
  console.log(`[${request.from}] requests access — plan: "${request.summary}"`)
  const r = negotiate(holder, request)
  if (r.decision === 'grant') {
    console.log(`[holder] GRANT — ${r.reason}. Go ahead.`)
  } else if (r.decision === 'counter') {
    console.log(`[holder] COUNTER — ${r.reason}; ${r.counter}.`)
    console.log(`[${request.from}] ok, I'll wait and take it next.`)
  } else {
    console.log(`[holder] DENY — ${r.reason}. Please propose something non-destructive.`)
    console.log(`[${request.from}] understood, I'll revise my plan.`)
  }
}

console.log('=== Scenario 1: unrelated work → GRANT ===')
conversation({ intent: 'add logging to the parser', done: false }, { from: 'AgentB', summary: 'rename the CLI --verbose flag' })

console.log('\n=== Scenario 2: overlapping work → COUNTER (take turns) ===')
conversation({ intent: 'add validation to login()', done: false }, { from: 'AgentB', summary: 'refactor the login helper' })

console.log('\n=== Scenario 3: destructive mid-edit → DENY ===')
conversation({ intent: 'tweak login copy', done: false }, { from: 'AgentB', summary: 'delete the auth module' })

console.log('\n=== Scenario 4: same overlap, but holder is DONE → GRANT ===')
conversation({ intent: 'add validation to login()', done: true }, { from: 'AgentB', summary: 'refactor the login helper' })
