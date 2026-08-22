import { describe, expect, it } from 'vitest';
import { isMailboxPatch, summarizePatch } from '../../../src/rewrite/patch/applyPatch';

const MAILBOX = `From 1234567890123456789012345678901234567890 Mon Sep 17 00:00:00 2001
From: A <a@x.dev>
Date: Thu, 1 Jan 2026 00:00:00 +0000
Subject: [PATCH] one

---
 a.txt | 1 +
 1 file changed, 1 insertion(+)

diff --git a/a.txt b/a.txt
index 0000000..1111111 100644
--- a/a.txt
+++ b/a.txt
@@ -0,0 +1 @@
+hello
`;

const PLAIN = `diff --git a/x.txt b/x.txt
index 2222222..3333333 100644
--- a/x.txt
+++ b/x.txt
@@ -1,2 +1,2 @@
-old
+new
 keep
@@ -10,1 +10,2 @@
 ctx
+added
`;

describe('patch engine (P12-T6)', () => {
  it('detects mailbox patches by the From <sha> header', () => {
    expect(isMailboxPatch(MAILBOX)).toBe(true);
    expect(isMailboxPatch(PLAIN)).toBe(false);
    // A body merely mentioning "From deadbeef" must not fool the detector.
    expect(isMailboxPatch('subject says From cafe\n' + PLAIN)).toBe(false);
  });

  it('summarizes files and hunk counts for the pre-apply dialog', () => {
    const summary = summarizePatch(PLAIN);
    expect(summary).toEqual([{ relPath: 'x.txt', hunks: 2, status: 'modified' }]);
  });
});
