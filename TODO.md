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
- [ ] `/change-password` page (currently returns 404)
- [x] Fix logout hydration error

### Onboarding
- [x] Aracoma Drug RX30 data import
- [ ] Gmail OAuth credentials for email sending (GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET)

---

## Medium Priority

### Dashboard Enhancements
- [ ] Real-time opportunity notifications
- [ ] Prescriber response tracking
- [ ] Patient communication log

### Triggers & Scanning
- [x] Negative GP opportunity discovery scanner (2026-01-29)
- [ ] Auto-rescan on new data upload

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

- [x] Negative GP opportunity discovery scanner - auto-finds losing drugs, suggests alternatives with positive GP on same BIN/GROUP, queues for admin review (2026-01-29)
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
