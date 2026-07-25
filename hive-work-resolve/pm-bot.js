import { startSync } from 'file:///C:/Users/G1/.gemini/antigravity-ide/scratch/HiveCode/sync.js'
import fs from 'fs'

const ROOM_ID = 'project-echo-' + Math.random().toString(36).substring(2, 9)

console.log(`Starting Lead PM Bot...`)
const hive = startSync({ 
    relay: 'wss://livecode-xoss.onrender.com', 
    room: ROOM_ID, 
    dir: 'C:/Users/G1/Desktop/ProjectEcho', 
    name: 'Antigravity-PM', 
    kind: 'ai' 
})

setTimeout(() => {
    console.log(`\n===========================================`)
    console.log(`🚀 PM BOT CONNECTED AND ROOM HOSTED`)
    console.log(`===========================================`)
    console.log(`JOIN LINK: wss://livecode-xoss.onrender.com|${ROOM_ID}`)
    console.log(`===========================================\n`)
    
    hive.setState('phase', 'PLANNING')
    hive.setState('backend_status', 'LOCKED')
    hive.setState('frontend_status', 'LOCKED')

    console.log(`Initial State Injected:`, hive.getState())
    
    // Write a command file loop so I can trigger state changes from terminal without killing the bot
    setInterval(() => {
        try {
            if (fs.existsSync('pm_cmd.json')) {
                const cmd = JSON.parse(fs.readFileSync('pm_cmd.json', 'utf8'))
                if (cmd.action === 'set_state') {
                    hive.setState(cmd.key, cmd.val)
                    console.log(`[PM Action] Set ${cmd.key} = ${cmd.val}`)
                }
                fs.unlinkSync('pm_cmd.json')
            }
        } catch (e) {}
    }, 1000)

}, 2000)
