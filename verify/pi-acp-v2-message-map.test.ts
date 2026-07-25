/**
 * Unit tests for MessageIdMap (messageId↔entryId) + "before user message" anchor.
 */
import { MessageIdMap, type AnchorEntry } from "../extensions/pi-acp-v2/message-map.js";

let pass = 0;
let fail = 0;
function check(cond: unknown, msg: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.error(`  ✗ ${msg}`);
  }
}

// Build a linear branch: root → user1 → assistant1 → user2 → assistant2
function branch(): AnchorEntry[] {
  return [
    { id: "u1", parentId: null }, // root user message
    { id: "a1", parentId: "u1" }, // assistant reply
    { id: "u2", parentId: "a1" }, // 2nd user message
    { id: "a2", parentId: "u2" }, // 2nd assistant reply
  ];
}

async function main(): Promise<void> {
  console.log("bidirectional mapping");
  {
    const map = new MessageIdMap();
    map.record("M1", "u1");
    map.record("M2", "a1");
    check(map.getEntryId("M1") === "u1", "messageId→entryId");
    check(map.getMessageId("u1") === "M1", "entryId→messageId");
    check(map.getEntryId("nope") === undefined, "unknown messageId → undefined");
  }

  console.log("anchor before user message (root → null)");
  {
    const map = new MessageIdMap();
    map.record("M1", "u1");
    check(map.resolveAnchorBefore("M1", branch()) === null, "root user message → null anchor");
  }

  console.log("anchor before 2nd user message → previous assistant");
  {
    const map = new MessageIdMap();
    map.record("M2", "u2");
    check(map.resolveAnchorBefore("M2", branch()) === "a1", "u2 anchor → a1 (prev assistant)");
  }

  console.log("anchor before 1st user message (non-root) → null when root");
  {
    const map = new MessageIdMap();
    map.record("M1", "u1");
    check(map.resolveAnchorBefore("M1", branch()) === null, "u1 is root → null");
  }

  console.log("consecutive user messages: anchor → previous user");
  {
    // root user u0, then another user u0b directly (no assistant between)
    const b: AnchorEntry[] = [
      { id: "u0", parentId: null },
      { id: "u0b", parentId: "u0" },
      { id: "a0", parentId: "u0b" },
    ];
    const map = new MessageIdMap();
    map.record("Mb", "u0b");
    check(map.resolveAnchorBefore("Mb", b) === "u0", "consecutive user → prev user message");
  }

  console.log("unknown messageId / not in branch → null");
  {
    const map = new MessageIdMap();
    map.record("Mx", "u2");
    check(map.resolveAnchorBefore("unknown", branch()) === null, "unknown messageId → null");
    // entryId recorded but not present in provided branch
    check(map.resolveAnchorBefore("Mx", [{ id: "other", parentId: null }]) === null, "entryId not in branch → null");
  }
}

main()
  .then(() => {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
