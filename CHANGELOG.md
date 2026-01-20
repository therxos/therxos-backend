# TheRxOS Changelog

All notable changes to the platform are documented here. Client-visible changes are marked with [CLIENT].

---

## [Unreleased]
- Demo video creation (AI generated or animated mockup)

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
