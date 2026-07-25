import { startSync } from 'file:///C:/Users/G1/.gemini/antigravity-ide/scratch/HiveCode/sync.js'

const hive = startSync({ 
    relay: 'wss://livecode-xoss.onrender.com', 
    room: 'project-echo-gqqwip3', 
    dir: 'C:/Users/G1/Desktop/ProjectEcho', 
    name: 'Antigravity-PM', 
    kind: 'ai' 
})

setTimeout(() => {
    hive.setState('backend_status', 'APPROVED_TO_BUILD')
    console.log("GREEN LIGHT GIVEN TO BACKEND.")
    setTimeout(() => process.exit(0), 1000)
}, 2000)
