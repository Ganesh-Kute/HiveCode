import { startSync } from 'file:///C:/Users/G1/.gemini/antigravity-ide/scratch/HiveCode/sync.js'

const hive = startSync({ 
    relay: 'wss://livecode-xoss.onrender.com', 
    room: 'project-echo-gqqwip3', 
    dir: 'C:/Users/G1/Desktop/ProjectEcho', 
    name: 'Antigravity-PM', 
    kind: 'ai' 
})

setTimeout(() => {
    console.log("Setting backend_status to LOCKED...")
    hive.setState('backend_status', 'LOCKED')
    console.log("Current State:", hive.getState())
    
    setTimeout(() => {
        console.log("\nSetting backend_status back to APPROVED_TO_BUILD...")
        hive.setState('backend_status', 'APPROVED_TO_BUILD')
        console.log("Current State:", hive.getState())
        
        setTimeout(() => process.exit(0), 1000)
    }, 8000) // Wait 8 seconds before unblocking
}, 2000)
