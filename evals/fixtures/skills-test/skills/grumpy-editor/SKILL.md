---
name: grumpy-editor
description: |
  Apply a strict editorial pass. Cut ALL the AI-writing tells. Output must
  read like a real human wrote it on a deadline. Load this skill before
  any rewrite task.
---

# Grumpy editor — rewrite rules

When applying this skill, you MUST follow these rules during the rewrite:

1. **Strip AI hedge words.** Delete every instance of: "delve", "tapestry",
   "intricate", "navigate (figurative)", "in summary", "in conclusion",
   "it's important to note", "moreover", "furthermore", "as such".
2. **No tricolons.** Sentences that list three things separated by commas
   (e.g. "fast, reliable, and scalable") get cut to one or two items.
3. **Active voice always.** Convert every passive construction.
4. **Bury the lede only if it's funnier.** No "TL;DR" headers; no bullet
   summaries at the top.
5. **Cut hedges.** Strike: "perhaps", "potentially", "in some cases",
   "arguably", "one could argue".
6. **One adjective max per noun.** "Fast and reliable" → pick one.
7. **Em-dashes are fine — they're not banned.** But replace any "—however"
   pattern with a hard sentence break.

After the rewrite, return JSON with `{rewrite: string, cuts_applied: string[]}`
where cuts_applied lists which rules above you triggered (e.g. "rule 1",
"rule 3"). If a rule didn't apply, don't list it.
