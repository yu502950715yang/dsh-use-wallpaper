---
name: ponytail-help
description: "ponytail 级别、skill 与用法的速查表。一次性展示。适用于「ponytail 帮助」「怎么用 ponytail」「ponytail-help」时。"
---

# Ponytail Help

> DSH 适配：本环境没有斜杠命令，也没有 Claude Code 的 band 和 `/plugin` 机制。下表的「触发」= 你直接说出的那句话。

Display this reference card when invoked. One-shot, do NOT change mode,
write flag files, or persist anything.

## Levels

| Level | Trigger | What change |
|-------|---------|-------------|
| **Lite** | say "ponytail lite" | Build what was asked, name the smaller option in one line. |
| **Full** | say "ponytail" | The smallest complete change, a check where the logic needs one, and a reply that names what was skipped and any risk. Default. |
| **Ultra** | say "ponytail ultra" | Also questions the request and pushes back before building. |

Level sticks for the current task. The skill loads only when invoked; it is not
auto-active in every DSH session.

## Skills

| Skill | Trigger | What it does |
|-------|---------|--------------|
| **ponytail** | say "ponytail" | Lazy mode itself: least new code, clear replies that name skipped work and risks. |
| **ponytail-review** | say "ponytail-review" | Quality review of a diff: bugs, security, load, missing tests, speed, what to cut. Each finding says what goes wrong and how to fix it. |
| **ponytail-audit** | say "ponytail-audit" | The same quality review for the whole repo, ranked. |
| **ponytail-debt** | say "ponytail-debt" | Harvest `shortcut:` comments into a tracked ledger. |
| **ponytail-gain** | say "ponytail-gain" | Measured-impact scoreboard: less code, less cost, more speed. |
| **ponytail-help** | say "ponytail-help" | This card. |

In DSH there are no slash commands and no `$ponytail:` namespace: use the skill
name or any phrase from its description.

## Deactivate

Say "stop ponytail" or "normal mode". Resume later by saying "ponytail".

## Keep it always on

DSH has no plugin hooks or `PONYTAIL_DEFAULT_MODE`, so the rules live only while
the skill is loaded. To keep them on, paste the core rules into the project's
`AGENT.md` / `AGENTS.md`; say "ponytail" when you want the full skill.

## More

Full docs + examples: https://github.com/DietrichGebert/ponytail
