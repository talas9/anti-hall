# Hard Gates Checklist — Per Stack

Hard gates are actions that NEVER autonomy-bypass. The driver agent MUST stop and
surface to the owner. This list is a generic starting point — add your project's own
stack-specific gates in the "Per-project additions" section.

---

## Universal hard gates (every project)

- [ ] **Force pushes** — `git push --force`, `git reset --hard`, amending pushed commits
- [ ] **Branch deletions** — including merged feature branches without owner confirmation
- [ ] **DB document/row deletions** — document-store deletes, SQL `DROP`, blob-store deletes
- [ ] **File deletions** — `rm -rf`, mass file removal
- [ ] **Production deploys** — serverless functions, containers, orchestrators, static hosts
- [ ] **Paid CI builds** — anything that triggers a build that costs money
- [ ] **Hook bypass** — `--no-verify`, `--no-gpg-sign`, disabling pre-commit/pre-push checks

## Cloud / infrastructure

- [ ] **Security-rule / access-policy deploys** — DB rules, IAM bindings, ACLs are owner-only
- [ ] **Index / schema deploys** — can take minutes and affect latency; owner approval
- [ ] **Function / service deploys** — production functions or services
- [ ] **IAM changes** — service-account permissions, roles, bindings
- [ ] **Project / resource deletion or disable** — never
- [ ] **Storage bucket / volume deletions** — never without explicit owner go

## Payment / financial

- [ ] **Refunds** — manual or programmatic
- [ ] **Subscription cancellations** — any provider
- [ ] **Chargeback handling** — never auto-decide
- [ ] **Payment transfers** — never
- [ ] **Pricing changes** — never push without owner

## CI/CD specific

- [ ] **Paid build minutes** — check cost; get owner go before triggering
- [ ] **Paid CI workflows** — larger runners, deployment workflows
- [ ] **Production environment deploys** — preview/staging fine; production gated
- [ ] **Container registry pushes** — image-tag overwrites of `latest` / `prod`

## App stores / distribution

- [ ] **Store submissions** — test tracks fine; production submission gated
- [ ] **Production rollouts** — internal testing fine; production rollout gated
- [ ] **In-app purchase product changes** — pricing, availability, region

## Communication / external

- [ ] **Sending emails to real users** — test addresses fine; broadcast gated
- [ ] **Pushing notifications to real users** — test devices fine; broadcast gated
- [ ] **Posting to public chat channels** — DMs / private owner channels usually fine
- [ ] **Creating issues / PR comments on others' work** — gated
- [ ] **Public posts (social)** — never auto

## Security

- [ ] **Secrets rotation** — gated; requires confirmation it's actually needed
- [ ] **Adding/removing user access** — never auto
- [ ] **Disabling 2FA / security features** — never
- [ ] **Audit-log modifications** — never

## Per-project additions

(Add stack-specific gates here — the deploy commands, financial providers, and
data-deletion CLIs your project actually uses.)

---

## When in doubt

If unsure whether an action is hard-gated, treat it AS IF it is. Surface to the
owner with the action description and ask for confirmation. Better to ask once than
to do something irreversible.
