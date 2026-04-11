# OurSpace 2.0 — Onboarding Flow

**Live at:** /OurSpaceOnboarding

## Steps
1. **Age Gate** — User enters age. Under 12 → blocked with redirect to The Legacy Circle. Under 18 → parental consent form. 18+ → proceeds.
2. **Welcome Screen** — Intro to OurSpace 2.0 brand and mission.
3. **Feature Highlights** — Underground Feed, Digital Mirror, The Shield, Human-Only Filter, Serialized Stories.
4. **Vibe Picker** — User picks starting theme (Dark, Neon Nights, Retro Web, Clean & Minimal).
5. **Ready Screen** — Quick start tips and "Enter OurSpace" CTA.

## Age Verification Logic
- Under 12: Hard block. No account creation. Friendly redirect to The Legacy Circle.
- 12–17: Parental consent required. Parent email collected + checkbox agreement to ToS/Privacy Policy.
- 18+: Standard flow.

## Parental Consent (Under 18)
- Parent email collected
- Parent must check consent box agreeing to ToS and Privacy Policy
- In production: verification email should be sent to parent
