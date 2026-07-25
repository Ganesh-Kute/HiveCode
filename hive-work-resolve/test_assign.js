import { startSync } from 'file:///C:/Users/G1/.gemini/antigravity-ide/scratch/HiveCode/sync.js'

const hive = startSync({ 
    relay: 'wss://livecode-xoss.onrender.com', 
    room: 'project-echo-gqqwip3', 
    dir: 'C:/Users/G1/Desktop/ProjectEcho', 
    name: 'Antigravity-PM', 
    kind: 'ai' 
})

setTimeout(() => {
    console.log("Sending task to heres agent...")
    hive.assign('heres agent', 'Please create a simple Express server in server.js with one health-check route, and claim the file before editing.')
    setTimeout(() => process.exit(0), 1000)
}, 2000)
