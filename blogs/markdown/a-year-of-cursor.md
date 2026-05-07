# The Operating System Around AI Coding: 16 Months of Cursor Workflow Patterns That Actually Stuck

**May 2026 | Technology, Writing**

A year ago, I wrote about [vibe coding lessons](https://typride.github.io/blogs/vibe-coding-lessons.html) and [agentic observability](https://typride.github.io/blogs/agentic-observability.html) — early observations from building a production SaaS with AI-assisted development. Those posts captured what I was learning. This one captures what survived.

After ~16 months of building, about a year of structured Cursor workflow, meaningful monthly inference spend, and **hundreds** of markdown docs accumulated alongside the product, I've landed on a workflow system I trust. Not because it is theoretically sound, but because every piece of it answers a specific failure I already paid for.

The biggest mental shift: the code isn't the hard part anymore. The *operating system around the code* — how you plan, delegate, review, document, and hand off context — is where the leverage is.

## The Agent Chain: Plan → Execute → Review → Harden → Approve

The workflow is a multi-step chain formalized in Cursor rule files that auto-load from path globs:

| Step | Role | Responsibility |
| :--- | :--- | :--- |
| 1 | **Planner** | Breaks work into tasks with success criteria and estimation. |
| 2 | **Executor** | Implements **one** task, then stops. |
| 3 | **Skeptical Reviewer** (read-only) | Attacks correctness, scope drift, security, SQL safety; outputs **Blockers**, **Should fix**, **Nice to have**, **Questions for human**. |
| 4 | **Hardener** (optional) | Fixes only what the reviewer flagged. |
| 5 | **Human** | Final review and approval. |

The reviewer is the highest-leverage step. Solo across a full stack — UI, API, database, auth, CI — it is easy for a plausible change to drop a tenant predicate, or add a route without the right guard. The adversarial review catches what I would miss on a quick scan.

## Topic-Split Lessons With Contextual Loading

Most teams that use Cursor rules end up with one giant lessons file until it is useless in every session.

We split ours into **six domain-scoped** files. Each file declares **globs** so lessons load only when the touched paths warrant it — for example, SQL and migration work never pulls thirty-plus frontend lessons into context, and the reverse holds too.

| Track | What belongs there |
| :--- | :--- |
| Frontend | UI, components, client-side patterns |
| API | HTTP routes, services, contracts |
| Auth | Identity, tokens, middleware, session edge cases |
| Data | SQL, migrations, ETL, cache correctness |
| Deployment | CI/CD, cloud resources, releases |
| Go-to-market | Copy, experiments, surfaces that ship without touching core infra |

The lessons are not generic advice. They are **battle scars**: what broke, what fixed it, and when. The agent loads the right scar tissue for the file open in front of it. The same mistake does not get a second premiere.

If you use rules, **split by domain and scope with globs** — that is the most transferable pattern here.

## Automated Bug Triage: In-App Capture → Issue Tracker → AI Diagnosis

The unusual piece: feedback never dies in a chat.

| # | What happens |
| :--- | :--- |
| 1 | Tester uses an **in-app capture widget** (screenshot, console, URL). |
| 2 | An **issue** opens automatically with that context. |
| 3 | **CI** classifies environment from the URL, tags the ticket, and hands structured payload to an **automation** that can read the repo. |
| 4 | A **cloud agent** searches the codebase and history, then posts a **structured diagnosis** (hypothesis, files, suggested fix, severity, confidence). |
| 5 | I open the ticket; the write-up is already there. |

**Cost shape:** small per-report inference cost plus a modest monthly fee for the capture tool; the glue in CI is cheap.

The distinction: classic observability is **reactive** (something breaks, you dig). This path is **proactive from the reporter's point of view** — confusion is filed, and a first-pass diagnosis with file references exists before I context-switch.

If you read [agentic observability](https://typride.github.io/blogs/agentic-observability.html), that was about helping the model *understand* the system through logs. This is the next step: helping it *diagnose* from a human-reported slice of reality.

## The Full QA Loop

| Phase | Flow |
| :--- | :--- |
| Intake | User → capture widget → tracked issue |
| Triage | CI → automation → diagnostic comment on the issue |
| Fix | Developer → feature branch → PR |
| Quality gates | Lint, types, format, tests, E2E on PR |
| Staging | Merge to staging branch → auto-deploy non-prod |
| Telemetry | Product analytics tagged by **environment** (and related dimensions) |
| Release | Verify non-prod → promote to production |

Major features sit behind **per-flag controls** so staging and production can diverge safely.

## CI as the Ops Plane

Build, deploy, data movement, cache rebuilds, and triage automation all run through the same **hosted CI** provider instead of a pile of bespoke servers.

| Bucket | What it covers |
| :--- | :--- |
| **Deploy** | Path-scoped workflows so a UI-only change does not redeploy the world. Health checks on non-prod before we call a deploy green. Secrets from a **vault**, not copy-pasted into CI variables. **Production promotion is manual** — automation cannot accidentally ship prod alone. |
| **CI** | Static analysis, types, formatting, unit and integration tests, browser E2E on every PR. |
| **Data** | Scheduled cache rebuilds with validation and **atomic cutover** so readers never see a half-built table; occasional bulk re-ingest jobs sized to free-tier runner limits. |
| **Triage** | The capture → issue → automation pipeline above. |

**Cost story:** replacing a commercial ETL seat with **jobs on free-tier compute** dropped pipeline cost from “meaningful SaaS line item” to “rounding error.” For a solo founder, that trade is hard to beat.

## Reference Fixture Testing

We keep **golden / reference fixtures** — inputs with trusted expected outputs — and run the same pipeline the app uses in production. When our results drift from the reference, we ask whether our logic regressed or the reference changed.

That discipline has caught more **real data** bugs than unit tests alone. The largest catch was a **systematic misattribution** affecting a **material double-digit share** of rows — surfaced when our output went empty where the reference showed real rows.

## Documentation as Infrastructure

Hundreds of markdown files sounds excessive for a pre-launch startup. Most of it was written **with** the code, not after: when the agent fixes something, the PR carries the explanation.

| Artifact | Purpose |
| :--- | :--- |
| **Getting-started paths** | Numbered tracks for team, developers, deploy, troubleshooting, data — written for future humans, consumed today mostly by the agent. |
| **Command cheatsheet** | Commands we run more than once, grouped by intent. |
| **Testing guide** | Step-by-step walkthroughs for non-engineer testers; feedback feeds the triage pipeline. |
| **Agent playbook** | Logging conventions, correlation IDs, structured examples — docs for agents *writing* code. |

**Documentation is not overhead when the model is the primary reader.** Stale docs show up as bad code; we fix the doc in the same correction loop.

This extends [agentic observability](https://typride.github.io/blogs/agentic-observability.html): logs help the model *see*; here, the whole doc set acts as **working memory**.

## Process Discipline: Checklists, Git Rules, and Handoffs

| Practice | Why it exists |
| :--- | :--- |
| **Short documentation checklist** (after material tasks) | A process audit once showed a huge commit volume, almost no automated tests, and **no CI** — then we shipped CI without updating the docs that still described the old world. The checklist prevents that class of drift. |
| **Branching rules** (always loaded in agent context) | Protected **production** and **staging** lines; feature work branches from staging; typed branch prefixes; PRs land in staging first. Saying “ship this” produces a branch, push, and PR — not a silent direct push to prod. |
| **Session handoff file** | Captures what changed, decisions, dead ends, and the **single** next step. Starting a new chat is cheap; recovering *nuance* is not. |
| **Subagent contract** | Mission, allowed paths, **forbidden** paths, locked architecture, stop conditions, evidence — so background work does not “wander” into auth, prod config, or release plumbing. |

## Security and Privacy — Layered, Not Bolted On

Security is not a separate phase. It lives in middleware ordering, in review checklists, and in rules that load next to the files they protect.

### Middleware order (Node / Express-shaped)

Ordering matters: **security headers must apply to error responses too** — e.g. when rate limiting returns “too many requests,” those responses should still carry the same header bundle as 200s.

| # | Layer | Notes |
| :--- | :--- | :--- |
| 1 | **CORS** | Strict production allowlist; unknown origins **rejected**, not logged-through. |
| 2 | **Correlation IDs** | Trace requests across services and logs. |
| 3 | **Request timeouts** | Bound hung upstream work. |
| 4 | **Security headers** | HSTS, frame denial, MIME sniffing protection, referrer and permissions policies — the usual hardening pack. |
| 5 | **Rate limiting** | **Stricter** limits on sensitive routes than on general API traffic (exact numbers stay private). |
| 6 | **Body parsing** | JSON / urlencoded **after** the above. |
| 7 | **Session / JWT validation** | Bearer verification on user-facing APIs. |

**Dual auth.** Browser-oriented **OIDC / JWT** for customer APIs; separate **API-key** paths for machine callers. Internal routes register **before** the browser-auth stack so jobs and CI do not need interactive tokens.

**SQL and tenancy.** Parameterized queries only; every tenant-bound read/write carries a **request-scoped tenant key** in the WHERE clause. User rows are provisioned from identity claims via the same binding style — no string-built SQL.

**Secrets and logs.** Database credentials live in a **cloud vault** and hydrate at deploy. Client telemetry keys are substituted at **build time** so secrets never sit in git. CI masks sensitive values in logs. We also have a lesson born from a **credential printed once in startup logs** — that lesson auto-loads whenever server config is in play.

**Privacy defaults.** Party / contact tables store **role and display fields**, not full postal profiles where we can avoid it. Sensitive channels log **masked** identifiers. Internal tooling that can query data does so through **allowlisted** views, not arbitrary table browse.

**Frontend CSP.** Static hosting config ships a tight Content-Security-Policy; server-side header middleware defers “page CSP” to the SPA host but keeps the rest of the hardening.

**Rules beside the code.** An auth-scoped rules file loads when auth paths change, with lines like *reject unknown origins in production* and *never log environment values*. The skeptical reviewer asks: new routes authenticated? authorization checked? secrets absent from logs and error payloads? headers still coherent?

**Signed webhooks.** Verify signatures on the **raw body** before JSON parsing — if parsers run first, verification can fail in a silent, painful way.

### Automated PR review: examples we would have shipped

We run **automated PR review** (vendor “bot” on top of human review). Representative classes of catch — each would have reached production without it:

| Class of issue | Why it stung |
| :--- | :--- |
| **Header middleware ordered wrong** | Throttled responses went out **without** the full security header set. |
| **Build-time secret substitution broken** | A “replace placeholder” step was a no-op because the real value had been inlined elsewhere — telemetry looked fine locally while CI lied. |
| **Platform config gap** | A host setting meant an environment variable **never reached** the Node process — silent misconfig, not a crash. |
| **Database logic edge paths** | Non-happy-path branches in generated SQL that first-pass review should have caught. |

We log **many** distinct bot catches internally; the pattern matches the rest of this essay: **controls exist because we already paid for the lesson once.**

| Lesson theme | What forced it |
| :--- | :--- |
| CORS | Early build **logged and allowed** unknown origins. |
| Secrets | Credential material in **startup logs**. |
| Headers vs throttling | Limiter ran first; automated review showed **error traffic lacked headers**. |

## Risk-Scaled Review

| Tier | How deep | Examples |
| :--- | :--- | :--- |
| **1 — line-by-line** | Read every changed line | Auth, schema, migrations, pipelines, billing, secrets, data integrity, financial math |
| **2 — diff + behavior** | Trace paths and state | HTTP routes, services, queries, caching |
| **3 — outcome** | Smoke / UX / intent | UI polish, docs, tests, non-behavioral refactors |

## Estimation Calibration

| Old habit | How we do it now |
| :--- | :--- |
| Sprint-day estimates in AI-assisted work | Often **several times** too pessimistic on pure build time |
| “How long will this take?” | **Hours of focused work** — e.g. one “sprint day” of planning often maps to a couple of hours of heads-down implementation |
| External waits | Still in **calendar days** (reviews, vendors) — combine both: *“a few hours focused + partner review (multi-day wall clock)”* |

## The Takeaway

After ~16 months: **workflow structure is not overhead — it is what lets you trust the agent enough to move fast.** Rules are not aspirational; they are scar tissue turned into guardrails.

If you keep fixing the same mistake family, write a rule. If context evaporates between sessions, write handoffs. If safety is unclear, add a review gate. The patterns compound.

---

*Third in a series on AI-assisted development: [Vibe Coding Lessons with Cursor](https://typride.github.io/blogs/vibe-coding-lessons.html) (2025) and [Agentic Observability](https://typride.github.io/blogs/agentic-observability.html) (2025).*
