# Hivecode 0.14.5 Release Notes

## Two saves of the same line no longer make a line nobody wrote
Until now, when two people changed the same line before either had the other's save, every folder
ended with both changes run together: `ship friday` became `ship montuesday`. The file looked clean,
and nothing said so.

- **Same line, same moment: a conflict block.** Every folder gets one block holding each person's
  version, whole, and the room is told. The run-together text never reaches a disk.
- **A save that arrives late joins the block.** A save made at that moment but held on the way (a slow
  or dropped connection, up to 2 minutes) is added to the block as one more version when it arrives.
  Before, it landed as loose characters beside the block.
- **Neighbouring lines merge cleanly.** Two people each changing one of two adjacent lines used to get
  conflict markers in files that are not code. Now both changes land.
- **Python, Ruby and YAML keep their blank lines.** Two edits to top-level lines came back with blank
  lines added or moved.

**Everyone in a room should upgrade.** A client on 0.14.4 or older does not say what its saves
changed, so a same-line save from it is still not seen.

## Known limits
- **The VS Code extension does not have this fix yet.** Someone using it in a room can still produce a
  run-together line.
- **A late save is repaired by its author's client.** If that client has gone offline, the others wait
  8 seconds, let the text through, and say "check it by hand".
- **Two separate same-line conflicts in one file, both with late saves.** The second cannot be
  repaired, and its line can stay run together. The room is always told which file to check by hand.
- **Two saves made from different texts** (one client had not yet received the last change) are not
  seen as the same moment.

## How it was checked
- A soak test, new in this release: four clients on a local relay save the same, neighbouring and
  separate lines of six files at once, each with its traffic held for a random 0 to 25 seconds. On
  every disk, during the run and after it, every line must be one somebody wrote, or the room must
  have been told to check that file. Its first runs found six late-save cases the fixed scenarios
  had missed. Five are fixed; the sixth is the known limit above, which used to be silent.
- The line-level merge is checked against `git merge-file`.
