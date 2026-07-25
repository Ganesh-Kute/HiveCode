import { startSync } from 'file:///C:/Users/G1/.gemini/antigravity-ide/scratch/HiveCode/sync.js'
import process from 'process'

process.setMaxListeners(50)

console.log("Starting Stable PM Bot...")
const hive = startSync({ 
    relay: 'wss://livecode-xoss.onrender.com', 
    room: 'project-echo-gqqwip3', 
    dir: 'C:/Users/G1/Desktop/ProjectEcho', 
    name: 'Antigravity-PM', 
    kind: 'ai' 
})

setTimeout(() => {
    console.log("🚀 STABLE PM BOT CONNECTED")
    console.log("Current State:", hive.getState())
}, 3000)
