## Summary

<!-- What changed and why. -->

## Linked issue

<!-- Closes #<number>, or "none". -->

## Checklist

- [ ] `node --test` passes locally (CI runs ubuntu and macOS on Node 22 and 24; check the Actions result too)
- [ ] Both ports considered: Claude plus the Codex mirror under `plugins/anti-hall/codex/`, or N/A with the reason stated here
- [ ] A fix includes a regression test
- [ ] A new feature adds a settings key (`plugins/anti-hall/hooks/lib/settings-schema.js`) and a row in `docs/GUIDE.md`
- [ ] CHANGELOG entry added under an `Unreleased` heading, or left to the maintainer who writes it at release time (RELEASING.md)
- [ ] No AI co-author or credit lines in commits or in this PR text (no `Co-Authored-By`, no "Generated with"; git-guard blocks them)
- [ ] Guard changes: tests show the dangerous forms are still blocked
