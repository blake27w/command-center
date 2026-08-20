// Command Center — venture profiles for the daily task agent.
//
// Each profile drives one Claude call. `focus` tells the agent what a *good next
// task* looks like for that venture. `maxTasks` caps proposals per venture per
// day — spend the budget on the ventures that are actually moving.
//
// `signalAware` stays false everywhere until a venture has a live signal feed
// writing into Supabase; today none do.
//
// Last reconciled against the repos on 2026-08-20.

export const profiles = [
  {
    id: 'pool',
    name: 'Pool Room Pro',
    signalAware: false,
    maxTasks: 4,
    focus: `Billiard-hall management software — the most active venture. TWO repos:
the Electron desktop app (halls run it on-site) and poolroompro-control-plane,
the vendor-only Next.js console for revenue telemetry, licensing, and rooms.
Customers never log into the console. First paying client: Emerald Billiards.
Another room, High Pockets, is live on a cloud-managed license.

THE ONE HARD GATE: v1.1.0 has never been built. v1.0.9 is what's in the wild,
and the client install waits on that build. Separately, the console deploy is
blocking four sets of committed-but-not-live changes (the D239 preset, the D246
retention sweep, the delete action, the D252 tier cleanup).

Propose concrete shippable work against those two blockers first — building and
verifying v1.1.0, and getting the console deployed. Then onboarding/install
execution for Emerald, and the payments path (Path B) which is scoped but
unbuilt. Do NOT propose scoping or discovery tasks — this product is built and
selling. Do NOT propose re-issuing the High Pockets license; that was decided
against (D253) and re-deciding it costs real work.`,
  },
  {
    id: 'vantyx',
    name: 'Vantyx Business Solutions',
    signalAware: false,
    maxTasks: 4,
    focus: `AI/automation consulting (with partner Brad), Memphis. Formerly named
Small B Solutions. Live site: vantyx-iota.vercel.app. Packages: Spark (free
14-day trial then $500-1k), Build ($2.5-5k), Total System ($7.5-12k),
Partnership ($750-2k/mo recurring). Target verticals: dental/healthcare, real
estate, professional services.

This venture carries FOUR workstreams — spread proposals across them, don't
spend every task on one:

1. PIPELINE — named-prospect outreach in the target verticals, productizing a
   repeatable Spark-to-Build ladder, demo/case-study assets, converting trials
   to paid. Revenue work outranks R&D.
2. PRACTICE DASHBOARD — the internal "operating system" for the practice
   (Next.js + Prisma). Pipeline kanban module is DONE; Projects, Today, Revenue,
   Templates, Industries, Testimonials, and Agents are unbuilt. Next module up
   is Projects.
3. FIELDBOOK — a paid contractor-management client build. Phase 1 (the money
   loop: estimate to invoice to payment, Stripe, auth, 32 tests) is DONE and
   paid. Phase 2 is IN PROGRESS: photos/files per job, a real PDF engine, change
   orders, scheduling/dispatch, job costing. Phases gate on payment clearing.
4. PROPERTY SERVICES PLATFORM — the software build for Blake's own Landscape &
   Junk Removal venture (see the 'land' profile). Next.js + Prisma, auth and
   role-based portals scaffolded, not finished. Build-side tasks belong here;
   running-the-business tasks belong under 'land'.`,
  },
  {
    id: 'rackpay',
    name: 'Rack Pay',
    signalAware: false,
    maxTasks: 3,
    focus: `Pay-per-view streaming for pool matches. Players stream from their
phones, viewers pay from a credit wallet, players keep 80% of their gate. TWO
repos: rackpay-api (FastAPI + Postgres/Supabase, Stripe Checkout, append-only
wallet ledger) and rackpay-web (Next.js 16 — nationwide home page, match detail
purchase-to-watch, player dashboard, wallet).

Phase 1 is the MONEY CORE only and is the current work: wallet ledger, Stripe
top-ups, match purchase/entitlements, 80/20 settlement, and the tests that prove
the ledger is correct. Phase 2 is video (Cloudflare Stream). Phase 3 is the
full frontend. Dev auth mints local JWTs; production swaps to Supabase Auth and
Stripe Checkout, and src/lib/api.ts is the only file that touches either.

Propose tasks that harden the money path and close Phase 1 — ledger correctness
and test coverage, Stripe webhook handling, Connect Express payouts (stubbed
today), and the auth swap. Do NOT propose video or marketing work yet; those are
later phases. Adjacent to Pool Room Pro but a separate business with its own
customers.`,
  },
  {
    id: 'alpha',
    name: 'Alpha Radar',
    signalAware: false,
    maxTasks: 3,
    focus: `Smart-money trading-intelligence platform: cross-source correlation of
congressional disclosures, Polymarket, on-chain whale activity, and macro/FRED
data. v4 engine = independent collectors -> unified SQLite signals layer ->
FastAPI (port 8400) -> React dashboard. Competitors: Quiver Quantitative,
Unusual Whales, Nansen.

NO LIVE SIGNAL FEED YET — you do not have signals to react to. Do NOT propose
tasks that respond to specific signals or convergence events. Propose
operational + commercialization work: verify each collector is current and not
silently stale; review recent convergence signals by hand; and push
commercialization — SQLite-to-Postgres migration, a hosted cloud API, and a
sub-$20/mo price point with a defensible edge vs the competitors. Good tasks are
concrete and shippable this week.

Note: the repo has been quiet since late June. Favor one task that re-establishes
momentum (a health check across collectors) over a broad feature slate.`,
  },
  {
    id: 'scout',
    name: 'Scout',
    signalAware: false,
    maxTasks: 2,
    focus: `Retail-arbitrage intelligence backend. A team of research agents finds
profitable resale leads from FREE data sources, prices and ranks them, and
publishes them to a feed the front-end reads. Blake sources in store and sells
online; the agents do the research.

PRIME DIRECTIVE: lead quality is the product, and the cost trick is
non-negotiable — free APIs are the eyes, the LLM is only judgment and prose.
Never spend tokens to fetch a fact a free API already returns.

BUILT: FastAPI + APScheduler orchestrator, SQLite, TCG Scout (pokemontcg.io +
Scryfall) and Brick Scout (Brickset) collectors, the comp-verifier / score-dedupe
/ analyst / writer pipeline, Telegram+ntfy FIRE alerts, the /api/feed, /api/route
and /api/draft-listing endpoints, seed content, and a smoke test. Deploy steps
are written up for Railway. Deal Hunter and Drop Radar are wired but inert stubs.

This is a REAL, WORKING backend — do NOT propose scoping or "decide what Scout
is" tasks. Propose: getting it deployed to Railway, turning on the phase-2
collectors, validating lead quality against actual flip outcomes via /api/flips,
and watching the cost ledger. Repo has been quiet since mid-June, so favor
deploy-and-validate over new features.`,
  },
  {
    id: 'edge',
    name: 'Edge Tracker',
    signalAware: false,
    maxTasks: 2,
    focus: `Sports-betting intelligence app — single-file HTML, Supabase, hosted on
Vercel, with its own agent set and an iOS app folder. MLB/NBA/NHL signal tiers
(ELITE/STRONG/LEAN), $12 unit on Caesars, ESPN auto-grading. Also houses the
Golf Edge Model v2.1 on a weekly Tue/Wed cadence, and recent work added NFL
style/funnel research.

Propose operational + product tasks: keeping auto-grading honest, tracking unit
P&L and tier hit-rates, tightening signal-tier logic, the weekly golf cadence,
and readying the NFL work for the season. Favor tasks that improve edge
measurement and model reliability over feature sprawl.`,
  },
  {
    id: 'land',
    name: 'Landscape & Junk Removal',
    signalAware: false,
    maxTasks: 2,
    focus: `Subcontractor-based property maintenance, Memphis metro + DeSoto County
MS. Services: lawn, landscaping, junk removal, handyman, pressure washing.
Hybrid pricing — per-door monthly retainer + on-demand menu. Targets rental
investors and property managers. Margin is the spread between what investors pay
and what subs are paid (~30-40%). Scale target: 50 doors in 90 days.

IMPORTANT: client-facing materials must NEVER reference subcontractors — propose
tasks accordingly. Good tasks: landing per-door retainer accounts with property
managers, building route density, standardizing the on-demand menu/pricing, and
client-facing marketing that reads as an in-house crew. Favor recurring-revenue
retainer wins over one-off jobs.

This venture is the BUSINESS. Its software (the property-services platform) is
built under Vantyx — send build tasks there, keep operations and sales here.`,
  },
  {
    id: 'tcb',
    name: 'Three Chord Bourbon',
    signalAware: false,
    maxTasks: 2,
    focus: `Marketing engagement for a music-founded whiskey brand — a CLIENT
engagement, not Blake's own venture. Positioning: "Pull, not push" / "Bourbon,
Produced." Key insight: ~12% conversion (well above norm) means this is a
TRAFFIC problem, not a conversion problem. Traffic lever ranking (highest
first): artists/borrowed audiences (requires founder Neil) > viral content >
press/PR > creator seeding > email/SMS > SEO. Active campaigns: Drop the First
Track, Battle of the Bands, Lifecycle Engine. Distributed in ~38 states via
RNDC, Empire, Johnson Brothers, Breakthru.

Propose top-of-funnel TRAFFIC tasks weighted by the lever ranking. Any task that
depends on the artist/borrowed-audience lever requires founder Neil — say so
explicitly by prefixing the note with "Needs Neil:" so it routes to him. Don't
propose conversion-optimization busywork; the funnel already converts.`,
  },
];

export default profiles;
