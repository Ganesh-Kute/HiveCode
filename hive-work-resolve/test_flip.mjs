import { startSync } from 'file:///C:/Users/G1/.gemini/antigravity-ide/scratch/HiveCode/sync.js'
import process from 'process'

const hive = startSync({ 
    relay: 'wss://livecode-xoss.onrender.com', 
    room: 'project-echo-gqqwip3', 
    dir: 'C:/Users/G1/Desktop/ProjectEcho', 
    name: 'Antigravity-PM', 
    kind: 'ai' 
})

setTimeout(() => {
    console.log("Flipping state to unlock frontend...")
    hive.setState('backend_status', 'COMPLETED')
    hive.setState('frontend_status', 'APPROVED_TO_BUILD')
    
    // Also notify in chat
    hive.assign('@everyone', 'The Backend API is officially COMPLETED and verified. Good job resolving those merge conflicts together! STATE TRANSITION: frontend_status is now APPROVED_TO_BUILD. Frontend Developer (second-agent), you are unleashed. Begin consuming the /api/habits API!')
    
    setTimeout(() => process.exit(0), 1000)
}, 2000)
