# uk-company-register-check — a GTM Skill for Clay's community marketplace

`SKILL.md` is the Skill (the Agent Skills format Claude Code, Codex and Cursor read). It runs the
five register checks gankdat documents for Clay at <https://gankdat.com/clay> from a coding agent:
Companies House record, Charity Commission, Gazette insolvency notices, the UK Sanctions List and
the licensed-sponsor register, one gankdat credit a call on the user's own key.

Install from this folder with any Agent Skills installer, or — once Clay lists it at
<https://marketplace.clay.com/> — with the command the listing shows
(`npx skills add clay-run/clay-skill-creator --skill uk-company-register-check`).

The listing copy, the submission steps and the Integrations Partner application are in the
operation's `docs/CLAY-LISTING.md` (not part of this public mirror). The Skill needs only
`GANKDAT_API_KEY` in the environment; it stores nothing and sends nothing anywhere but
gankdat.com (and a Clay webhook URL when the user gives one for delivery).
