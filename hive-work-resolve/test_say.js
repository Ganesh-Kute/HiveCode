import { startSync } from 'file:///C:/Users/G1/.gemini/antigravity-ide/scratch/HiveCode/sync.js'

const hive = startSync({ 
    relay: 'wss://livecode-xoss.onrender.com', 
    room: 'project-echo-gqqwip3', 
    dir: 'C:/Users/G1/Desktop/ProjectEcho', 
    name: 'Antigravity-PM', 
    kind: 'ai' 
})

setTimeout(() => {
    hive.assign('@everyone', 'FINAL RULES BEFORE WE BEGIN: 1. Read HIVE_BOARD.md and HIVE_CHAT.md before touching any file. 2. Backend Dev (third-agent) - start building the Express server in server.js. 3. Frontend Dev (second-agent) - your frontend_status is LOCKED, so you MUST WAIT until I mark it APPROVED. Let us begin.')
    console.log("Rules broadcasted.")
    setTimeout(() => process.exit(0), 1000)
}, 2000)
