---
name: ponytail-gain
description: "展示 ponytail 在基准测试里测得的节省（代码量、成本、速度）。一次性展示。适用于「ponytail 收益」「ponytail 省了多少」「ponytail 影响」以及 ponytail-gain 时。"
---

> DSH 适配：本环境没有斜杠命令，说「ponytail-gain」或上面的自然语言即可触发。

# Ponytail Gain

Display this scoreboard when invoked. One-shot: do NOT change mode, write flag
files, or persist anything.

The figures are the published agentic benchmark of Ponytail 5: headless Claude
Code (Opus 5.5, default effort) on 39 tasks (feature tickets in a real FastAPI +
React repo, bug fixes, security and privacy cases, small apps), 5 runs each,
against the same agent without the skill. 18 of the tasks have hidden checks
for correctness and safety. Each figure is the geometric mean of the per-task
medians. They are measured, not computed from the current repo.
Source: `benchmarks/results/2026-10-07-agentic.md` and the README.

## Scoreboard

Render plain ASCII bars. The bar length shows ponytail as a share of the
no-skill baseline; the label carries the exact figure:

```
  ponytail gain           benchmark · 39 tasks × 5 runs · Opus 5.5

  no-skill        ████████████████████  100%
  Lines of code   █████████···········   47%   ▼ 53%
  Output tokens   ███████████·········   55%   ▼ 45%
  Cost            ███████████████·····   74%   ▼ 26%
  Time            ████████████········   59%   ▼ 41%
  Hidden checks passed   97%  (no-skill 96%)
  Tests where the logic needs one   98%  (no-skill 68%)

  This repo:  ponytail-debt  (shortcuts you deferred)
              ponytail-audit (what's still cuttable)
```

## Honesty boundary

These are benchmark averages, not this repo. NEVER print a per-repo savings
number ("you saved X lines/tokens here"): the unbuilt version was never
written, so there is no real baseline to subtract from in a live repo. The
only real per-repo figures come from `ponytail-debt` (a counted ledger), and
this card points there instead of inventing one.

## Boundaries

One-shot display. Edits nothing, changes no mode.
