# PathForge Monetization Plan

## Model: Freemium subscription, metered by AI usage

Every meaningful interaction (chat, node generation, step content) is an OpenRouter call on `google/gemini-3.1-flash-lite`, so the natural metering unit is **AI calls**, not seats or projects. Chat is the highest-frequency, highest-value operation (16384 max_tokens, happens continuously through a session), so it's the right lever for a free→paid wall.

Before locking a price or caps, get real OpenRouter cost-per-token for this model and real average session length from the Phase 1 beta (see `docs/launch-plan.md` if that gets written) — the numbers below are starting points, not final.

## Tiers

### Free — the hook, not a demo
- 1 active project at a time (archived/completed ones don't count against this)
- Capped chat messages per day (start conservative, e.g. 15–20/day — easy to loosen later, hard to tighten after users are used to more)
- Node map generation: allowed once per project (regenerating via `[REGENERATE_SESSION]` / the revise-plan flow is Pro-only — it's the most expensive single operation in the app)
- No node spawning beyond 1–2 per project (`spawn_node` creates a whole new AI-generated learning path)
- Dashboard recommendations: generate once, "New ideas" refresh is Pro-only

### Pro ($/month, price TBD after real cost data) — unlocks the ceiling, not new features
- Unlimited projects, unlimited daily chat
- Unlimited regenerate/spawn/refresh actions
- (Optional later: priority queue / faster model tier if a heavier Gemini model is ever added as an option)

**Design rationale**: free-tier users experience the *full product* on one project — they're not missing features, just capacity. That's the right frame for a learning tool where the whole pitch is "personalized AI tutoring," not a feature-gated product.

### Why not usage-based/pay-as-you-go
A fixed monthly price beats "I don't know how much I'll be charged" for a consumer learning product. Worth revisiting only if Pro users' actual usage varies wildly once there's real data.

## Technical plan

1. **Schema**: add `plan` (`free`/`pro`), `stripeCustomerId`, `stripeSubscriptionId`, `subscriptionStatus`, `currentPeriodEnd` — recommend a separate `subscriptions` table rather than bolting onto `learnerProfilesTable`, to keep billing state decoupled from profile data. Add a lightweight `usage_counters` table (`clerkUserId`, `date`, `chatMessageCount`) rather than trying to derive usage from the jsonb chat history blobs.
2. **Stripe**: Checkout Session endpoint (`POST /billing/checkout`), webhook handler (`subscription.created/updated/deleted`) to keep `subscriptionStatus` in sync, and link out to Stripe's hosted Customer Portal for plan management/cancellation rather than building that UI in-house.
3. **Enforcement**: a small `requirePlanOrLimit` check inserted at the top of the expensive routes (`/chat`, `/generate-map`, `/spawn`, `/revise-plan`, recommendation regenerate) — returns a distinct error shape the frontend recognizes and turns into an upgrade prompt, not a generic error.
4. **Frontend**: pricing page, upgrade CTA triggered by the limit-hit response (not a separate nag banner), a simple "X/20 messages today" indicator so free users see the ceiling coming instead of hitting it as a surprise.

## Sequencing

Don't build the Stripe integration itself until after a Phase 1 private beta produces real usage numbers (messages per session, actual OpenRouter spend) — you want that data before locking a price or caps. Building the *schema + enforcement scaffolding* ahead of that is fine and low-risk since it doesn't require Stripe to be live yet.

## Open questions to resolve before implementation

- Exact free-tier daily message cap (needs beta usage data)
- Pro tier price point (needs real cost-per-user data)
- Whether free tier resets daily or monthly
- Student/education discount tier, given the target market skews toward learners
