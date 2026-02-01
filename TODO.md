# TheRxOS To-Do List

Running list of features, fixes, and improvements. Updated each session.

---

## DEPLOYMENT RULE (FOR CLAUDE)

**After deploying to staging, STOP and WAIT for user approval before deploying to production.**

Do NOT automatically push to production after staging. The user needs time to test the staging deployment and confirm it's working before going live. Only deploy to production when the user explicitly says to proceed.

---

## CRITICAL - Data Recovery

### Bravo Missing Opportunities (Jan 27, 2026) - RESOLVED
- [x] **RECOVERED**: 133 missing actioned opportunities restored from backup
  - Bravo: 126 opportunities (36 Completed, 11 Approved, 66 Submitted, 3 Denied, 8 Didn't Work, 2 Flagged)
  - Marvel: 7 opportunities (5 Completed, 1 Approved, 1 Denied)
  - Backup used: db_cluster-27-01-2026@08-30-49.backup

### Protections Added (Jan 27, 2026)
- [x] Database trigger `protect_actioned_opportunities` - PREVENTS deletion of actioned opportunities
- [x] Audit log `opportunity_audit_log` - Permanent immutable record of ALL changes (133 entries logged)
- [x] Updated CLAUDE.md with critical rules about never deleting actioned opportunities

---

## High Priority

### Demo & Marketing
- [ ] Create demo video (options: Synthesia AI, animated HTML mockup, or screen recording)
- [ ] Add waitlist form/modal when beta reaches 10 pharmacies

### Client Features
- [x] `/change-password` page (verified working - page exists, builds, login redirects here when mustChangePassword=true)
- [x] Fix logout hydration error

### Onboarding
- [x] Aracoma Drug RX30 data import
- [ ] Gmail OAuth credentials for email sending (GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET)
- [x] Self-service onboarding pipeline (Calendly → upload → BAA → dashboard → agreement → Stripe → active)
- [x] Auto-upload client tool (PowerShell scheduled task for pharmacy desktops)

### Pending Deployment (Jan 30, 2026)
- [ ] Deploy to staging: scanner trigger_id fix, admin.js BIN/notes fixes, opportunity-approval.js GP fix, onboarding pipeline, auto-upload tool
- [ ] Run migrations 019 + 020 on database
- [ ] Configure Calendly webhook URL
- [ ] Set CALENDLY_WEBHOOK_SECRET env var

---

## Medium Priority

### Dashboard Enhancements
- [ ] Real-time opportunity notifications
- [ ] Prescriber response tracking
- [ ] Patient communication log

### Triggers & Scanning
- [x] Negative GP opportunity discovery scanner (2026-01-29)
- [x] Auto-rescan on new data upload (built into onboarding upload + auto-upload tool)

### Admin Tools
- [ ] Bulk client email (send updates to all active clients)
- [ ] Usage analytics per pharmacy
- [ ] Audit log for admin actions

---

## Low Priority / Future

### Integrations
- [ ] Direct PMS API connections (beyond CSV upload)
- [ ] Pharmacy network benchmarking

### Advanced Features
- [ ] AI-powered opportunity prioritization
- [ ] Prescriber relationship scoring
- [ ] Predictive analytics (which opportunities most likely to convert)

---

## Completed Recently

- [x] Self-service onboarding pipeline: Calendly webhook → auto-create profile → delayed login email → BAA acceptance → CSV upload with progress → scanner → read-only dashboard → service agreement → Stripe checkout → auto-activation (2026-01-30)
- [x] Auto-upload client tool: PowerShell + batch installer, watches Desktop\TheRxOS folder, POSTs to API with per-pharmacy API key, moves to Sent folder (2026-01-30)
- [x] Fast ingestion service module: extracted ingest-fast.js into reusable service with async progress tracking (2026-01-30)
- [x] Scanner trigger_id fix: opps now linked to triggers for coverage confidence display (2026-01-30)
- [x] BIN restriction enforcement in admin.js scan endpoints (3 endpoints fixed) (2026-01-30)
- [x] Staff notes auto-populate removed (was adding "Scanned for trigger" text) + cleaned 4,143 notes (2026-01-30)
- [x] Legacy junk cleanup across ALL pharmacies: deleted 8,000+ legacy opps, DQIs, pending types (2026-01-30)
- [x] Opportunity detail view fix: pr.gross_profit → computed from insurance_pay + patient_pay - acquisition_cost (2026-01-30)
- [x] Prescriber backfill: auto-copied prescriber from linked prescriptions to 1,323 opportunities (2026-01-30)
- [x] Negative GP opportunity discovery scanner (2026-01-29)
- [x] Client-facing changelog in dashboard sidebar (2026-01-19)
- [x] Website best fit updated for smaller pharmacies (25K+ scripts) (2026-01-19)
- [x] Test email feature for admin (2026-01-19)
- [x] Status editing in admin panel (2026-01-19)
- [x] Split Live/Demo pharmacy tables (2026-01-19)
- [x] Live website stats with category breakdowns (2026-01-19)
- [x] Beta slots remaining / waitlist mode (2026-01-19)
- [x] Dashboard 2000 cap fix (2026-01-17)
- [x] Login accepts email OR username (2026-01-17)
- [x] Document generation (BAA, Service Agreement) (2026-01-17)
- [x] Email service with attachments (2026-01-17)
- [x] CMS Medicare formulary integration (2026-01-18)
- [x] Coverage scanner fixes (2026-01-18)

---

## Notes

- Marvel Pharmacy (formerly Hero) is the test/demo environment
- Beta capacity: 10 pharmacies
- Current live + onboarding: Check `/api/admin/public-stats`
