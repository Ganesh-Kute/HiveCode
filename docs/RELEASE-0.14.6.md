# Hivecode 0.14.6 Release Notes

## The hosted relay moved
The hosted relay is now `wss://livecode-xoss.onrender.com`. The previous address,
`hivecode-relay.onrender.com`, ran out of hours for the month and stopped answering.

- **Nothing to change by hand.** A room link, a `.hive.json` or a `HIVE_RELAY` that names the previous
  address is followed to the new one, and the client says so.
- **Upgrade to reach it.** 0.14.5 and older treat the new address as retired and send it back to the
  previous one, so they cannot connect until they upgrade:
  `npx -y hivecode-mcp@latest`.
- Rooms were not carried over. The first person to rejoin a room from a folder that still holds its
  files brings them back.

Checked against the live relay with two clients: a file crossed in about a second, a same-line race
gave one conflict block on both disks, and a link naming the previous address reached the same room.
