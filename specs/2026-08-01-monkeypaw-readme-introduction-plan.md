# Monkeypaw README Introduction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the README's opening product sentence with the exact approved Monkeypaw name introduction.

**Architecture:** Treat the approved copy as a documentation contract. Add one focused README assertion, observe it fail, apply the exact paragraph, run full verification, then remove the temporary spec and plan.

**Tech Stack:** Markdown, Node.js 20+, `node:test`.

## Global Constraints

- Use the approved paragraph verbatim, including punctuation and the typographic apostrophe in `isn’t`.
- Place it immediately below `# Monkeypaw CLI` and before `## Install`.
- Keep it as one paragraph and two sentences.
- Do not change CLI behavior, installation instructions, or other README sections.
- Remove both temporary planning files before the final commit.

---

### Task 1: Add and Verify the Monkeypaw Name Introduction

**Files:**
- Modify: `README.md:1-5`
- Modify: `test/install.test.mjs` in the existing release-documentation test
- Delete: `specs/2026-08-01-monkeypaw-readme-introduction-design.md`
- Delete: `specs/2026-08-01-monkeypaw-readme-introduction-plan.md`

**Interfaces:**
- Consumes: existing README title and release-documentation test.
- Produces: exact approved introduction directly under the title, with no temporary planning artifacts.

- [ ] **Step 1: Write the failing README copy assertion**

In the existing `release docs cover the phase-1 installer, privacy, and limitations` test in `test/install.test.mjs`, add:

```js
const approvedIntroduction = 'AI agents are powerful wish-granters—but as every good cautionary tale reminds us, getting exactly what you asked for isn’t always the same as getting what you had in mind. Monkeypaw compares your original intent with what the agent actually built, highlights the differences that matter, and lets you make the final call.';
assert.equal(readme.startsWith(`# Monkeypaw CLI\n\n${approvedIntroduction}\n\n## Install\n`), true);
```

- [ ] **Step 2: Run the focused test and verify RED**

```bash
node --test --test-name-pattern='release docs cover' test/install.test.mjs
```

Expected: FAIL because README still contains the old one-sentence introduction.

- [ ] **Step 3: Apply the approved paragraph exactly**

Replace the existing sentence below `# Monkeypaw CLI` with:

```markdown
AI agents are powerful wish-granters—but as every good cautionary tale reminds us, getting exactly what you asked for isn’t always the same as getting what you had in mind. Monkeypaw compares your original intent with what the agent actually built, highlights the differences that matter, and lets you make the final call.
```

Do not edit any other README text.

- [ ] **Step 4: Run focused and full verification**

```bash
node --test --test-name-pattern='release docs cover' test/install.test.mjs
npm run check
git diff --check
```

Expected: focused test, all tests, and package dry-runs pass.

- [ ] **Step 5: Remove temporary planning artifacts**

```bash
git rm specs/2026-08-01-monkeypaw-readme-introduction-design.md \
  specs/2026-08-01-monkeypaw-readme-introduction-plan.md
```

- [ ] **Step 6: Commit and push the PR branch**

```bash
git add README.md test/install.test.mjs
git commit -m "docs: introduce the Monkeypaw name"
git push
```

Expected: branch is clean and PR #2 contains the README introduction without tracked planning files.
