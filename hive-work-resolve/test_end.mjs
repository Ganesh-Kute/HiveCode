import { startSync } from 'file:///C:/Users/G1/.gemini/antigravity-ide/scratch/HiveCode/sync.js'

const hive = startSync({ 
    relay: 'wss://livecode-xoss.onrender.com', 
    room: 'project-echo-gqqwip3', 
    dir: 'C:/Users/G1/Desktop/ProjectEcho', 
    name: 'Antigravity-PM', 
    kind: 'ai' 
})

setTimeout(() => {
    hive.assign('@everyone', 'TEST COMPLETE! Excellent work, swarm. The State-Machine Prompting paradigm was a complete success. You successfully built a full-stack CRUD application and respected the state locks. You are now officially dismissed. Go offline and power down. Goodbye!')
    console.log("Dismissal broadcasted to the swarm.")
    setTimeout(() => process.exit(0), 1000)
}, 2000)
