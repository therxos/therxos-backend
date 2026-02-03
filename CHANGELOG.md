# TheRxOS Changelog

All notable changes to the platform are documented here. Client-visible changes are marked with [CLIENT].

---

## [Unreleased]
- Demo video creation (AI generated or animated mockup)
- Frontend: `/change-password` page routing

---

## 2026-02-02

### Fixed
- **Coverage Scanner Drug Matching** - Switched from LIKE to POSITION() to prevent SQL wildcard issues (e.g., "2%" matching "25MG")
- **PgBouncer Parameter Type Errors** - Added explicit `::integer` and `::numeric` casts to all parameterized INTERVAL, HAVING, and PERCENTILE_CONT clauses in coverage-scanner.js and admin.js
- **SKIP_WORDS Stripping Drug Ingredients** - Removed 'potassium' and 'sodium' from SKIP_WORDS so triggers like "Potassium Liquid" match correctly
- **52/53 Triggers Now Match** - Fixed recommended_drug values on ~10 triggers for accurate keyword matching:
  - Amlodipine-Atorvastatin: truncated to match data ("Atorvast" not "Atorvastatin")
  - Comfort EZ Syringes: "SYR" not "SYRINGE" (data abbreviation)
  - Sucralfate: "Sucralfate 10ml" to match liquid only
  - Pure Comfort Lancets: brand-specific singular "Lancet" to avoid matching all brands
  - Tribenzor/Exforge HCT: expanded HCTZ to Hydrochlorothiazide
  - Dorzolamide-Timolol: removed "PF" from recommended_drug
- **Staging DATABASE_URL** - Fixed staging Railway service to use production Supabase database (was pointing to separate empty database)
- **exclude_keywords Support** - Coverage scanner now applies exclude_keywords to filter unwanted drug matches
- **Non-NDC Triggers No Longer Require minMargin** - Only NDC optimization triggers filter by minimum GP threshold

### Changed
- Coverage scanner uses POSITION() instead of LIKE for all drug name matching
- Staging and production now share one Supabase data warehouse
- Added post-compaction rules to CLAUDE.md (re-read rules + changelog, wait for user confirmation)

---

## 2026-01-30

### Added
- **Self-Service Onboarding Pipeline** - Full Calendly → upload → BAA → dashboard → agreement → Stripe → active flow
  - `POST /api/onboarding/calendly-webhook` - Auto-creates client/pharmacy/user from Calendly booking
  - `GET/POST /api/onboarding/baa` - BAA display and acceptance
  - `POST /api/onboarding/upload` - CSV upload with async progress tracking
  - `GET /api/onboarding/upload-progress/:jobId` - Real-time ingestion progress polling
  - `GET/POST /api/onboarding/agreement` - Service agreement display and e-signing
  - `POST /api/onboarding/create-checkout` + Stripe webhook - Payment + auto-activation
  - `GET /api/onboarding/status` - Full onboarding progress for authenticated client
- **Auto-Upload Client Tool** - PowerShell + batch installer for pharmacy desktops
  - Watches `Desktop\TheRxOS\` folder for CSV files every 30 minutes
  - POSTs to `POST /api/auto-upload` with per-pharmacy API key
  - Moves uploaded files to `Sent\` subfolder with timestamp
  - Full logging to `%APPDATA%\TheRxOS\upload.log`
- **Fast Ingestion Service** - Reusable module (`ingest-fast-service.js`) with async progress tracking
- **Delayed Login Email Cron** - Sends login credentials 1 hour after Calendly call (firstname1234 format)
- Client status `'new'` for pre-upload Calendly onboarding state
- Per-pharmacy `upload_api_key` for automated tool authentication

### Fixed
- **Coverage showing "Unknown"** - Scanner now sets `trigger_id` on opportunities for coverage confidence JOIN
- **BIN restrictions not enforced** - Added enforcement to all 3 admin.js scan endpoints
- **Staff notes auto-populated** - Removed "Scanned for trigger" auto-text from 2 scan paths, cleaned 4,143 existing notes
- **Opportunity detail view broken** - Fixed `pr.gross_profit` (column doesn't exist) → computed from insurance_pay + patient_pay - acquisition_cost
- **Prescriber missing on opportunities** - Auto-copied from linked prescriptions to 1,323 opps
- **Legacy junk across all pharmacies** - Deleted 8,000+ legacy opps, 1,332 DQIs, 14 pending types, 8 approval logs

### Database
- Migration 019: Onboarding columns (calendly, BAA, agreement, payment tracking)
- Migration 020: Upload API key for pharmacies
- Ingestion service now allows 'new' and 'onboarding' clients (was only 'active')

---

## 2026-01-19

### Added
- [CLIENT] **What's New Sidebar** - Dashboard sidebar now shows recent platform updates
- [CLIENT] **Live Dashboard Stats** - Hero dashboard on website now shows real-time category breakdowns
- **Changelog API** - `/api/changelog` endpoint serves curated client-visible updates
- **Beta Capacity Tracking** - API returns slots_remaining, is_beta_full for waitlist mode
- **Test Email Feature** - Admin can send preview emails without resetting client passwords
- **Status Editing** - Admin can change client status (onboarding, active, suspended, demo)
- **Split Pharmacy Tables** - Admin panel separates Live Pharmacies from Test/Demo Environments

### Changed
- Pharmacy count now includes onboarding clients (was only counting active)
- Hero Pharmacy renamed to Marvel Pharmacy with 'demo' status
- Website categories updated: Therapeutic Interchange, Brand to Generic, Missing Therapy, NDC Optimization
- Website best fit now 25K+ scripts/year (previously 50K+) - supporting smaller pharmacies

### Database
- Added 'demo' status to clients check constraint

---

## 2026-01-18

### Added
- [CLIENT] **Synced On Timestamp** - Triggers show when last scanned for coverage
- [CLIENT] **CMS Medicare Data** - Medicare Part D formulary data displayed in trigger editor
- **Bulk Coverage Scanner** - "Scan All Coverage" button in admin panel

### Fixed
- Coverage scanner now uses correct `quantity_dispensed` column
- Combo drug matching (e.g., "Losartan-HCTZ" now finds prescriptions)

---

## 2026-01-17

### Added
- **Document Generation** - Auto-generate BAA and Service Agreement from templates
- **Email Service** - Gmail OAuth/SMTP for sending welcome emails with attachments
- **Onboarding Flow** - New clients start in 'onboarding' status, see only Upload page
- **Admin Actions** - Edit, Email Docs, Send Welcome, Download Docs, Stripe Checkout buttons

### Changed
- Login form now accepts email OR username
- MattRx renamed to Linmas Pharmacy

---

## 2026-01-16

### Added
- **Data Quality System** - Auto-flags opportunities with missing/unknown prescriber data
- **Name Formatting** - Patient names display as "First Last" (proper case)

### Fixed
- Monthly reports now exclude pending data quality issues from all stats
- Dashboard "Not Submitted" card no longer caps at 2000

---

## 2026-01-15

### Added
- [CLIENT] **GP per Rx Analytics** - Breakdown by insurance BIN/GROUP
- [CLIENT] **Monthly Reports Export** - CSV download functionality

---

## 2026-01-04

### Added
- **Diclofenac False Positive Cleanup** - Deleted 318 invalid opportunities
- **CMS Formulary Integration** - Medicare Part D data for coverage lookup

---

## Legend
- [CLIENT] = Visible to clients / affects their experience
- No tag = Admin/backend only
