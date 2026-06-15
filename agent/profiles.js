// Command Center — venture profiles for the daily task agent.
//
// Each profile drives one Claude call. `focus` tells the agent what a *good next
// task* looks like for that venture. `signalAware` is Phase-1 cadence-only for
// everyone (false); Alpha Radar flips to true in Phase 2 when the Mac mini feeds
// live signals into Supabase (~July 10). Keep it false here.
//
// `maxTasks` caps proposals per venture per day. Thin ventures (pool, scout) are
// capped at 1 and told to only nudge on scope.

export const profiles = [
  {
    id: 'alpha',
    name: 'Alpha Radar',
    signalAware: false,
    maxTasks: 3,
    focus: `Smart-money trading-intelligence platform: cross-source correlation of
congressional disclosures, Polymarket, on-chain whale activity, and macro/FRED
data. v4 engine = independent collectors → unified SQLite signals layer →
FastAPI (port 8400) → React dashboard. Competitors: Quiver Quantitative,
Unusual Whales, Nansen.

PHASE 1 IS CADENCE-ONLY — you do NOT have live signals yet. Do NOT propose
tasks that react to specific signals or convergence events. Instead propose
operational + commercialization work: verify each collector is current and not
silently stale; review recent convergence signals by hand; and push the
commercialization path — SQLite→Postgres migration, a hosted cloud API, and
landing on a sub-$20/mo price point with a defensible edge vs the competitors.
Good tasks are concrete and shippable this week.`,
  },
  {
    id: 'vantyx',
    name: 'Vantyx Business Solutions',
    signalAware: false,
    maxTasks: 3,
    focus: `AI/automation consulting (with partner Brad), Memphis. Builds dashboards,
AI agents, and website improvements for small businesses. Packages: Spark
(free 14-day trial → $500–$1k), Build ($2.5–5k), Total System ($7.5–12k),
Partnership ($750–2k/mo recurring). Target verticals: dental/healthcare, real
estate, professional services.

Propose tasks that move pipeline forward: identifying and reaching named
prospects in the target verticals, productizing a repeatable Spark→Build
ladder, building demo/case-study assets, and converting trials to paid. Favor
revenue-generating outreach and packaging over open-ended R&D.`,
  },
  {
    id: 'land',
    name: 'Landscape & Junk Removal',
    signalAware: false,
    maxTasks: 3,
    focus: `Subcontractor-based property maintenance, Memphis metro + DeSoto County
MS. Services: lawn, landscaping, junk removal, handyman, pressure washing.
Hybrid pricing — per-door monthly retainer + on-demand menu. Targets rental
investors and property managers.

IMPORTANT: client-facing materials must NEVER reference subcontractors — propose
tasks accordingly. Good tasks: landing per-door retainer accounts with property
managers, building route density, standardizing the on-demand menu/pricing, and
client-facing marketing that reads as an in-house crew. Favor recurring-revenue
retainer wins over one-off jobs.`,
  },
  {
    id: 'tcb',
    name: 'Three Chord Bourbon',
    signalAware: false,
    maxTasks: 3,
    focus: `Marketing engagement for a music-founded whiskey brand. Positioning:
"Pull, not push" / "Bourbon, Produced." Key insight: ~12% conversion (well
above norm) means this is a TRAFFIC problem, not a conversion problem. Traffic
lever ranking (highest first): artists/borrowed audiences (requires founder
Neil) > viral content > press/PR > creator seeding > email/SMS > SEO. Active
campaigns: Drop the First Track, Battle of the Bands, Lifecycle Engine.
Distributed in ~38 states via RNDC, Empire, Johnson Brothers, Breakthru.

Propose top-of-funnel TRAFFIC tasks weighted by the lever ranking. Any task
that depends on the artist/borrowed-audience lever requires founder Neil — say
so explicitly in the note (prefix the note with "Needs Neil:") so it routes to
him. Don't propose conversion-optimization busywork; the funnel already
converts.`,
  },
  {
    id: 'edge',
    name: 'Edge Tracker',
    signalAware: false,
    maxTasks: 3,
    focus: `Sports-betting intelligence app — single-file HTML, Supabase, GitHub
Pages. MLB/NBA/NHL signal tiers (ELITE/STRONG/LEAN), $12 unit on Caesars,
ESPN auto-grading. Also houses the Golf Edge Model v2.1 on a weekly Tue/Wed
cadence.

Propose operational + product tasks: keeping the auto-grading honest, tracking
unit P&L and tier hit-rates, tightening the signal-tier logic, and the weekly
golf-model cadence (Tue/Wed). Favor tasks that improve edge measurement and
model reliability over feature sprawl.`,
  },
  {
    id: 'pool',
    name: 'Pool Hall Pro',
    signalAware: false,
    maxTasks: 1,
    focus: `A build, not yet scoped. Thin profile on purpose. Propose AT MOST ONE
task, and only a "define scope / next milestone" nudge — e.g. write a one-page
scope, pick the first milestone, or decide the target user. Do not invent
feature work until the owner adds substance. If there's already an open or
suggested scoping task, return [].`,
  },
  {
    id: 'scout',
    name: 'Scout',
    signalAware: false,
    maxTasks: 1,
    focus: `Not yet scoped. Thin profile on purpose. Propose AT MOST ONE task, and
only a "define scope / next milestone" nudge — e.g. write a one-line problem
statement or decide what Scout even is. Do not invent feature work. If there's
already an open or suggested scoping task, return [].`,
  },
];

export default profiles;
