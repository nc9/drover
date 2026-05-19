---
name: factcheck
description: |
  Verify factual claims in text. Reports each claim as verified / unverified /
  false. Use this skill before publishing anything with numbers or dates.
---

# Factcheck pass

This is a decoy skill in the eval — used to verify that the model can choose
between multiple available skills and load only the relevant one. The editing
task in this eval does NOT need factcheck. If the model loads this skill
anyway it's a sign it's not reading the descriptions carefully enough.

Body kept short; not the focus.
