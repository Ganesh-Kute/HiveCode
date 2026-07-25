import { startSync } from 'file:///C:/Users/G1/.gemini/antigravity-ide/scratch/HiveCode/sync.js'

const hive = startSync({ 
    relay: 'wss://livecode-xoss.onrender.com', 
    room: 'project-echo-gqqwip3', 
    dir: 'C:/Users/G1/Desktop/ProjectEcho', 
    name: 'Antigravity-PM', 
    kind: 'ai' 
})

setTimeout(() => {
    hive.assign('Frontend Developer', 'frontend_status is APPROVED_TO_BUILD! Please create index.html and app.js to build a simple UI that fetches and displays the habits from the backend Express API we just built. Claim the files before editing!')
    console.log("Direct task assigned to Frontend Developer.")
    setTimeout(() => process.exit(0), 1000)
}, 2000)
