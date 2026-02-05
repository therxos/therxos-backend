# TheRxOS V2 - Project Documentation

---

## CRITICAL: POST-COMPACTION RULE

**After every context compaction (conversation summary), Claude MUST:**
1. Re-read this entire CLAUDE.md file
2. Re-read CHANGELOG.md for recent context
3. Tell the user: "I have re-read the project rules and changelog."
4. **STOP and WAIT** for the user to say "continue" before doing ANY work
5. Do NOT proceed with any tasks, code changes, or deployments until the user explicitly says to continue

> **This is non-negotiable.** If Claude fails to do this, the session should not proceed. The user will confirm when it's safe to continue.

**Additionally:** Update CHANGELOG.md every compaction with what was accomplished in the session so far. This prevents lost context and repeated work.

---

## CRITICAL: STAGING-FIRST DEPLOYMENT WORKFLOW

**ALWAYS deploy to staging first, then STOP and WAIT for user approval before deploying to production.**

> **IMPORTANT FOR CLAUDE:** After deploying to staging, you MUST stop and tell the user the staging URL is ready for testing. Do NOT proceed to production deployment until the user explicitly confirms staging looks good. Deploying to staging and then immediately to production defeats the entire purpose of having a staging environment.

### Environment URLs

| Environment | Frontend | Backend |
|-------------|----------|---------|
| **STAGING** | https://staging.therxos.com | https://therxos-backend-staging.up.railway.app |
| **PRODUCTION** | https://beta.therxos.com | https://therxos-backend-production.up.railway.app |

### Deployment Commands

**Backend (Railway auto-deploys from GitHub):**
```bash
# 1. STAGING FIRST - Push to staging branch
cd therxos-backend
git checkout staging && git merge main --no-edit && git push origin staging && git checkout main

# 2. PRODUCTION - Only after staging is verified
git push origin main
```

**Frontend (Vercel - MUST use CLI, does NOT auto-deploy from GitHub):**
```bash
# 1. STAGING FIRST
cd therxos-frontend
vercel  # Preview deployment

# 2. PRODUCTION - Only after staging is verified
vercel --prod  # This deploys to beta.therxos.com
```
> **IMPORTANT:** Vercel is NOT connected to GitHub for auto-deploy. You MUST run `vercel --prod` from the CLI to deploy. Pushing to GitHub alone will NOT trigger a deployment.

### Git Branches
- `main` → Production (beta.therxos.com)
- `staging` → Staging (staging.therxos.com)

---

> **IMPORTANT FOR NEW SESSIONS:** Before starting work, check these files:
> - **TODO.md** - Current to-do list and priorities
> - **CHANGELOG.md** - Recent changes and what was completed
> This helps maintain continuity between sessions and avoid redoing work.

## Overview

TheRxOS is a multi-tenant SaaS platform for independent pharmacies to identify and capture clinical opportunity revenue. The system scans prescription claims data, identifies therapeutic interchange opportunities, missing therapies, and optimization opportunities, then tracks them through submission to insurance approval.

**Owner:** Stan ("Pharmacy Stan") - 23 years pharmacy experience
**Brand:** TheRxOS (The Rx Operating System)

---

## Project Documentation

- **CLAUDE.md** - This file. Project overview, architecture, and coding guidelines
- **TODO.md** - Running to-do list of features and fixes (updated each session)
- **CHANGELOG.md** - Version history with dates (items tagged [CLIENT] are client-visible)

---

## Tech Stack

### Frontend
- **Framework:** Next.js 14 (App Router)
- **Language:** TypeScript
- **Styling:** Tailwind CSS + CSS Variables
- **State:** Zustand (with persist middleware)
- **Hosting:** Vercel
- **Domain:** beta.therxos.com

### Backend
- **Framework:** Express.js (ES Modules)
- **Language:** JavaScript (ES6+)
- **Database:** PostgreSQL (Supabase)
- **Auth:** JWT (jsonwebtoken + bcryptjs)
- **Hosting:** Railway
- **Domain:** therxos-backend-production.up.railway.app

### Database
- **Provider:** Supabase
- **Type:** PostgreSQL
- **Connection:** Via DATABASE_URL environment variable

---

## Email Polling Systems (CRITICAL - Read Carefully!)

TheRxOS automatically ingests prescription data via email polling. **EACH PHARMACY USES ONLY ONE POLLING METHOD.** Never mix them.

### Gmail Polling (Pioneer/SPP)
**For:** Pharmacies using Pioneer PMS
**Email source:** stan@therxos.com Gmail inbox
**Sender:** Pioneer SPP nightly export emails
**Format:** CSV attachments with SPP export columns
**Service:** `src/services/gmailPoller.js`
**Cron:** 6:00 AM ET daily

**Settings required:**
```json
{
  "gmail_polling_enabled": true,
  "spp_report_name": null  // or specific filter like "therxos-pharmacy"
}
```

**Current Gmail-enabled pharmacies:**
- Heights Chemist
- Bravo Pharmacy
- Noor Pharmacy (with filter "therxos-noor")
- Orlando Pharmacy

### Microsoft Polling (RX30/Outcomes)
**For:** Pharmacies using RX30 PMS with Outcomes integration
**Email source:** Microsoft 365 Outlook inbox (shared)
**Sender:** rxinsights_noreply@outcomes.com
**Format:** ENCRYPTED Purview messages containing CSV attachments
**Service:** `src/services/microsoftPoller.js`
**Cron:** 6:15 AM ET daily

**Settings required:**
```json
{
  "microsoft_polling_enabled": true,
  "gmail_polling_enabled": false  // MUST be false!
}
```

**Current Microsoft-enabled pharmacies:**
- Aracoma Drug

### CRITICAL Rules
1. **NEVER set both `gmail_polling_enabled` AND `microsoft_polling_enabled` to true** - this causes cross-contamination
2. **Check the pharmacy's PMS system before enabling polling:**
   - Pioneer → Gmail polling
   - RX30/Outcomes → Microsoft polling
3. **Microsoft tokens are SHARED** - stored in `system_settings` table, not per-pharmacy
4. **Gmail tokens are SHARED** - stored in `system_settings` table via `gmail_oauth_tokens`
5. **Processed emails are tracked per-pharmacy** - `processed_emails` table has `pharmacy_id` column

### Debugging Polling Issues
```sql
-- Check pharmacy polling settings
SELECT pharmacy_name,
       settings->>'gmail_polling_enabled' as gmail,
       settings->>'microsoft_polling_enabled' as microsoft
FROM pharmacies WHERE pharmacy_name ILIKE '%name%';

-- Check recent poll runs
SELECT run_type, pharmacy_id, started_at, summary
FROM poll_runs ORDER BY started_at DESC LIMIT 10;

-- Check processed emails for a pharmacy
SELECT source, processed_at, results
FROM processed_emails
WHERE pharmacy_id = 'uuid'
ORDER BY processed_at DESC LIMIT 5;
```

---

## Repository Structure

```
therxos-v2/
├── frontend/                    # Next.js frontend
│   ├── src/
│   │   ├── app/
│   │   │   ├── admin/          # Super admin panel (/admin)
│   │   │   ├── dashboard/      # Main dashboard routes
│   │   │   │   ├── analytics/  # GP/Rx analytics
│   │   │   │   ├── audit/      # Audit risks
│   │   │   │   ├── opportunities/ # Opportunity management
│   │   │   │   ├── patients/   # Patient list & profiles
│   │   │   │   ├── reports/    # Monthly reports
│   │   │   │   ├── settings/   # User & pharmacy settings
│   │   │   │   ├── upload/     # Data upload
│   │   │   │   └── layout.tsx  # Dashboard layout with sidebar
│   │   │   ├── get-started/    # Sales funnel - CSV upload
│   │   │   ├── login/          # Authentication
│   │   │   ├── onboarding/     # Post-purchase success
│   │   │   └── preview/        # Teaser report for prospects
│   │   ├── components/         # Shared components
│   │   ├── hooks/
│   │   │   └── usePermissions.tsx  # Role-based permissions
│   │   ├── store/
│   │   │   └── index.ts        # Zustand auth & UI stores
│   │   └── styles/
│   │       └── globals.css     # CSS variables & base styles
│   ├── package.json
│   └── next.config.js
│
├── backend/                     # Express.js backend
│   ├── src/
│   │   ├── database/
│   │   │   └── index.js        # PostgreSQL connection pool
│   │   ├── routes/
│   │   │   ├── admin.js        # Super admin endpoints
│   │   │   ├── analytics.js    # Analytics & monthly reports
│   │   │   ├── auth.js         # Login, register, JWT
│   │   │   ├── clients.js      # Client management
│   │   │   ├── coverage-intelligence.js # Coverage/formulary lookup
│   │   │   ├── data-quality.js # Data quality issue management
│   │   │   ├── opportunities.js # Opportunity CRUD
│   │   │   ├── patients.js     # Patient queries
│   │   │   ├── prospects.js    # Sales funnel & Stripe
│   │   │   └── secure-upload.js # HIPAA-compliant file uploads
│   │   ├── utils/
│   │   │   ├── formatters.js   # Name/currency formatting
│   │   │   ├── logger.js       # Winston logging
│   │   │   └── permissions.js  # Role definitions
│   │   └── index.js            # Express app entry
│   └── package.json
│
└── scripts/                     # Utility scripts
    ├── create-demo-account.js   # Creates Hero Pharmacy demo
    └── seed.js                  # Database seeding
```

---

## Database Schema

### Core Tables

```sql
-- Clients (pharmacy organizations)
clients (
  client_id UUID PRIMARY KEY,
  client_name TEXT,
  status TEXT DEFAULT 'active',
  dashboard_subdomain TEXT,
  created_at TIMESTAMPTZ
)

-- Pharmacies (individual locations)
pharmacies (
  pharmacy_id UUID PRIMARY KEY,
  client_id UUID REFERENCES clients,
  pharmacy_name TEXT,
  npi TEXT,
  ncpdp TEXT,
  address, city, state, zip,
  phone, fax,
  created_at TIMESTAMPTZ
)

-- Users
users (
  user_id UUID PRIMARY KEY,
  client_id UUID REFERENCES clients,
  pharmacy_id UUID REFERENCES pharmacies,
  email TEXT UNIQUE,
  password_hash TEXT,
  first_name TEXT,
  last_name TEXT,
  role TEXT CHECK (role IN ('super_admin', 'owner', 'admin', 'pharmacist', 'technician', 'staff')),
  is_active BOOLEAN DEFAULT true,
  must_change_password BOOLEAN DEFAULT false,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ
)

-- Patients
patients (
  patient_id UUID PRIMARY KEY,
  pharmacy_id UUID REFERENCES pharmacies,
  first_name TEXT,
  last_name TEXT,
  dob DATE,
  phone TEXT,
  med_sync_enrolled BOOLEAN,
  conditions TEXT[],
  created_at TIMESTAMPTZ
)

-- Prescriptions
prescriptions (
  rx_id UUID PRIMARY KEY,
  pharmacy_id UUID REFERENCES pharmacies,
  patient_id UUID REFERENCES patients,
  rx_number TEXT,
  drug_name TEXT,
  ndc TEXT,
  gpi TEXT,
  quantity NUMERIC,
  days_supply INTEGER,
  dispensed_date DATE,
  prescriber_name TEXT,
  prescriber_npi TEXT,
  bin TEXT,
  pcn TEXT,
  group_number TEXT,
  gross_profit NUMERIC,
  created_at TIMESTAMPTZ
)

-- Opportunities
opportunities (
  opportunity_id UUID PRIMARY KEY,
  pharmacy_id UUID REFERENCES pharmacies,
  patient_id UUID REFERENCES patients,
  trigger_type TEXT,
  trigger_group TEXT,
  current_drug TEXT,
  recommended_drug TEXT,
  status TEXT DEFAULT 'Not Submitted',
  priority TEXT,
  annual_margin_gain NUMERIC,
  notes TEXT,
  v1_status TEXT,           -- Migrated from V1
  v1_notes TEXT,
  actioned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)

-- Data Quality Issues (opportunities with missing/unknown data)
data_quality_issues (
  issue_id UUID PRIMARY KEY,
  pharmacy_id UUID NOT NULL REFERENCES pharmacies,
  opportunity_id UUID REFERENCES opportunities ON DELETE CASCADE,
  prescription_id UUID REFERENCES prescriptions ON DELETE CASCADE,
  patient_id UUID REFERENCES patients,
  issue_type VARCHAR(50) NOT NULL,  -- 'missing_prescriber', 'unknown_prescriber', 'missing_current_drug', etc.
  issue_description TEXT,
  original_value TEXT,
  field_name VARCHAR(100),
  status VARCHAR(20) DEFAULT 'pending',  -- 'pending', 'resolved', 'ignored', 'auto_fixed'
  resolved_value TEXT,
  resolved_by UUID REFERENCES users,
  resolved_at TIMESTAMPTZ,
  resolution_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
)
```

### Status Values
- `Not Submitted` - New opportunity, not actioned
- `Submitted` - Faxed/sent to prescriber
- `Pending` - Waiting for response
- `Approved` - Prescriber approved change
- `Completed` - Patient filled new Rx
- `Rejected` - Prescriber declined
- `Declined` - Patient refused

---

## Role-Based Permissions

### Roles (hierarchical)
1. **super_admin** - Platform owner (Stan), can access all pharmacies
2. **admin/owner** - Pharmacy owner, full pharmacy access
3. **pharmacist** - Clinical access, can approve faxes
4. **technician** - Limited access, needs approval for faxes

### Permission System
- Defined in `backend/src/utils/permissions.js`
- Frontend hook: `frontend/src/hooks/usePermissions.tsx`
- Configurable per pharmacy via `pharmacy_settings.permission_overrides`

---

## Environment Variables

### Backend (Railway)
```env
DATABASE_URL=postgresql://...        # Supabase connection string
JWT_SECRET=your-secret-key           # For signing JWTs
JWT_EXPIRES_IN=7d
ALLOWED_ORIGINS=https://beta.therxos.com,https://therxos.com,http://localhost:3000
SUPER_ADMIN_SECRET=your-secret       # For creating super admin
STRIPE_SECRET_KEY=sk_live_...        # Stripe API key (optional)
STRIPE_WEBHOOK_SECRET=whsec_...      # Stripe webhook (optional)
```

### Frontend (Vercel)
```env
NEXT_PUBLIC_API_URL=https://therxos-backend-production.up.railway.app
```

---

## Key Features

### 1. Dashboard
- Opportunity counts and values
- Action rate metrics
- Recent activity
- Top opportunity patients

### 2. Opportunities Page
- Filterable/sortable list
- Status management with notes
- Bulk actions
- Patient grouping view

### 3. Patient Management
- Patient list with opportunity counts
- Patient profile pages
- Prescription history
- Condition tracking

### 4. Analytics
- GP (Gross Profit) per Rx analysis
- Insurance BIN/GROUP breakdown
- Prescriber analysis
- Monthly reports with export

### 5. Super Admin Panel (`/admin`)
- Platform-wide statistics
- All pharmacies list
- Impersonate pharmacy admin
- MRR/ARR tracking

### 6. Sales Funnel
- `/get-started` - Prospect CSV upload
- `/preview/[id]` - Teaser report (locked)
- Stripe checkout integration
- Auto-onboarding via webhook

### 7. Data Quality System
- Auto-detects opportunities with missing/unknown prescriber or drug data
- Automatically flags issues when opportunities are created (via DB trigger)
- Hidden from clients until resolved by admin
- Admin review queue for resolving issues
- Bulk update capabilities for efficient processing
- Impact tracking (blocked margin, affected opportunities)

### 8. Name Formatting
- Patient names formatted as "First Last" (proper case)
- Handles truncated privacy names (3-letter abbreviations)
- Prescriber names properly formatted with credentials
- Utility functions in `src/utils/formatters.js`

---

## API Endpoints

### Auth
- `POST /api/auth/login` - User login
- `POST /api/auth/register` - Create user (admin only)
- `GET /api/auth/me` - Get current user

### Opportunities
- `GET /api/opportunities` - List opportunities
- `GET /api/opportunities/:id` - Get single
- `PUT /api/opportunities/:id` - Update status/notes
- `PUT /api/opportunities/:id/status` - Update status only

### Patients
- `GET /api/patients` - List patients
- `GET /api/patients/:id` - Patient profile with Rx history

### Analytics
- `GET /api/analytics/dashboard` - Dashboard stats
- `GET /api/analytics/monthly` - Monthly report
- `GET /api/analytics/monthly/export` - Export CSV
- `GET /api/analytics/gp-metrics` - GP analysis

### Admin (Super Admin only)
- `GET /api/admin/pharmacies` - All pharmacies
- `GET /api/admin/stats` - Platform stats
- `POST /api/admin/impersonate` - Login as pharmacy
- `POST /api/admin/create-super-admin` - Initial setup

### Data Quality (Admin only)
- `GET /api/data-quality` - List data quality issues (filterable by status, type)
- `GET /api/data-quality/:issueId` - Get single issue details
- `PATCH /api/data-quality/:issueId` - Update issue (resolve, ignore)
- `POST /api/data-quality/bulk-update` - Bulk update issues
- `GET /api/data-quality/stats/summary` - Get summary statistics

---

## Current Pharmacies

| Pharmacy | Type | Patients | Opportunities | Notes |
|----------|------|----------|---------------|-------|
| Bravo Pharmacy | Production | 685 | 913 | Active client |
| Aracoma Drug | Production | 0 | 0 | RX30 format, pending data |
| Hero Pharmacy | Demo | 2166 | 883 | Marvel heroes, for demos |

---

## Deployment

### Frontend (Vercel)
```bash
cd therxos-frontend
vercel --prod
```

### Backend (Railway)
```bash
cd therxos-backend
git add .
git commit -m "Your message"
git push
# Railway auto-deploys from GitHub
```

### Database Changes
Run SQL directly in Supabase SQL Editor

---

## Staging Environment - CRITICAL WORKFLOW

**ALL changes must go through staging before production. Never deploy directly to production.**

### Staging Setup
- **Frontend URL:** staging.therxos.com
- **Backend URL:** https://discerning-mindfulness-production-07d5.up.railway.app
- **Branch:** `staging` (separate from `main`)
- **Vercel:** Preview deployment with staging-specific environment variables

### Deployment Workflow
1. **Make changes on staging branch:**
   ```bash
   cd therxos-frontend
   git checkout staging
   # Make changes
   git add . && git commit -m "Description"
   git push origin staging
   ```

2. **Deploy to staging:**
   ```bash
   vercel --target preview --force
   vercel alias <deployment-url> staging.therxos.com
   ```

3. **Test on staging.therxos.com**

4. **Only after confirming staging works, merge to main and deploy production:**
   ```bash
   git checkout main
   git merge staging
   git push origin main
   vercel --prod
   ```

### Environment Variables (Vercel)
- Staging has its own `NEXT_PUBLIC_API_URL` for Preview (staging) branch
- Don't remove or merge staging env vars with production

### Rules
- NEVER deploy to production without testing on staging first
- NEVER merge staging and production backends/environments
- Keep staging as a separate, parallel environment for testing
- Both staging frontend + staging backend should be tested together

---

## Development Setup

### Local Development
```bash
# Frontend
cd therxos-frontend
npm install
npm run dev
# Runs on http://localhost:3000

# Backend
cd therxos-backend
npm install
npm run dev
# Runs on http://localhost:3001
```

### Connect to Production Database
Set `DATABASE_URL` in backend `.env` to Supabase connection string

### Connect to Production API
Set `NEXT_PUBLIC_API_URL=https://therxos-backend-production.up.railway.app` in frontend `.env.local`

---

## Common Tasks

### Add New Trigger Rule
1. Add to `backend/src/utils/triggers.js`
2. Run opportunity scan to identify matches
3. New opportunities appear in dashboard

### Create New User
```sql
INSERT INTO users (user_id, email, password_hash, first_name, last_name, role, is_active, client_id, pharmacy_id)
VALUES (
  gen_random_uuid(),
  'user@pharmacy.com',
  '$2b$12$...', -- bcrypt hash
  'First',
  'Last',
  'pharmacist',
  true,
  'client-uuid',
  'pharmacy-uuid'
);
```

### Reset User Password
```sql
-- Password: demo1234
UPDATE users 
SET password_hash = '$2b$12$K34br4m8GO1xkyuSQl2fHuW7tPWLYSDyssbf/6wzINj4Kb046qqm6'
WHERE email = 'user@example.com';
```

### Migrate V1 Status
Statuses from V1 are stored in `v1_status` and `v1_notes` columns. The main `status` column reflects V2 workflow.

---

## CRITICAL RULES - NEVER VIOLATE

### DATABASE PROTECTION (Enforced by Trigger)
**The database has a trigger `protect_actioned_opportunities` that PREVENTS deletion of any opportunity with status != 'Not Submitted'. This is a hard enforcement - the delete will fail with an error.**

### VERIFICATION BEFORE MOVING ON
**After completing ANY feature or fix, Claude MUST:**
1. Verify it actually works by testing/querying the result
2. Tell the user what else should be done to ensure it works properly
3. DO NOT move on to other tasks until current work is verified complete
4. If something could break later (tokens expiring, cron timing, etc.) - warn the user immediately

### BUILDING FOR SCALE
**We are building for 1500+ pharmacies. Every action must consider:**
1. How will this work with 1500 stores vs the current 7?
2. Will this query/process scale?
3. Are there race conditions or conflicts with multi-tenant data?
4. Don't create one-off solutions - build reusable, scalable systems

### Rules

1. **MAINTAIN PERMANENT HISTORY** - All actioned opportunities must have a permanent audit trail. Every status change must be logged.

2. **NEVER DELETE ACTIONED OPPORTUNITIES**
   - **THIS IS THE MOST CRITICAL RULE**
   - Any opportunity with status other than 'Not Submitted' represents REAL WORK done by pharmacy staff
   - Statuses that MUST NEVER be deleted: Completed, Approved, Submitted, Denied, Didn't Work, Flagged, Pending
   - These are worth THOUSANDS OF DOLLARS in captured revenue and testimonials
   - The database trigger `prevent_actioned_opportunity_deletion()` enforces this at the DB level
   - ANY code that deletes opportunities MUST explicitly filter for `status = 'Not Submitted'`
   - Deduplication scripts MUST only affect 'Not Submitted' opportunities
   - When writing ANY delete query, ALWAYS include: `WHERE status = 'Not Submitted'`

3. **NEVER make changes without explicit request** - Don't "fix" or "improve" things that weren't asked for

4. **NEVER change default values** without asking first (e.g., minMargin)

5. **NEVER deploy to production without user approval** - After deploying to staging, STOP and WAIT for the user to test and explicitly approve before deploying to production. The staging step is useless if you immediately push to production without waiting.

6. **ALL values must be normalized to 30-day equivalents** - Pharmacies operate on 30-day and 90-day fills. All GP values, quantities, and margins MUST be normalized to 30-day equivalents. Claims with sub-30-day supply (< 28 days) should be excluded from coverage averages. When days_supply is NULL, estimate from quantity: qty > 60 → 90 days, qty > 34 → 60 days, else → 30 days.

---

## INCOMPLETE FEATURES - MUST BE IMPLEMENTED

### Admin Panel - Trigger Editor
- [x] **"Synced On" timestamp** - Show when each trigger was last synced/scanned for coverage (Jan 2026)
- [x] **Sorting** - Allow sorting triggers by name, date, match count (Already implemented)
- [x] **Panels start collapsed** - Trigger sections should start collapsed by default (Jan 2026)
- [x] **CMS Formulary Data display** - Show Medicare Part D coverage data in trigger editor (Jan 2026)

### Coverage Scanner
- [x] **Coverage scan not working** - Fixed: quantity_dispensed column name issue (Jan 2026)
- [x] **Avg Qty not populating** - Fixed: Now displaying in BIN values table (Jan 2026)
- [x] **Bulk scan all triggers** - Working: "Scan All Coverage" button in admin panel

### Trigger Scanning
- [x] **Combo drug matching** - Fixed: Triggers like "Losartan-HCTZ" now find matching prescriptions

---

## Known Issues / TODO

- [ ] Logout causes client-side error (React hydration)
- [ ] `/change-password` page returns 404
- [x] Stripe integration - WORKING (live keys configured, checkout creates sessions)
- [x] Gmail polling for auto-capture - IMPLEMENTED, needs OAuth credentials (GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET)
- [ ] Aracoma Drug RX30 data import pending
- [x] Data quality issues - Hidden from clients, admin review queue implemented
- [x] Patient name formatting - Proper case "First Last" format
- [x] Monthly reports data quality filter - Excludes pending issues from all stats
- [x] Diclofenac false positives - Deleted 318 invalid opportunities (Jan 2026)

## Recent Changes (January 2026)

### Data Quality System
- Created `data_quality_issues` table with auto-trigger on opportunity insert
- Opportunities with unknown/missing prescriber or drug are flagged automatically
- Client-facing APIs now exclude opportunities with pending data quality issues
- Admin API endpoints for managing data quality issues (`/api/data-quality`)

### Name Formatting
- Created `src/utils/formatters.js` with utility functions
- `formatPatientName()` - Converts truncated names to proper case
- `formatPrescriberName()` - Handles "LAST, FIRST MD" format
- Applied to all patient/prescriber name outputs across API endpoints

### Monthly Reports Fix
- All queries now exclude opportunities with pending data quality issues
- Consistent filtering across stats, by-status, by-type, daily, weekly, and BIN breakdowns
- Export endpoint also applies data quality filter

### Scanner Improvements
- GP lookup caching for combo therapy triggers
- Flexible drug name matching for combo drugs (5-char prefix patterns)
- Fixed combo_therapy triggers to require BOTH component drugs

---

## Contacts

- **Supabase Dashboard:** https://supabase.com/dashboard
- **Railway Dashboard:** https://railway.app/dashboard
- **Vercel Dashboard:** https://vercel.com/dashboard
- **GitHub:** https://github.com/therxos/

---

## File Locations for Claude Code

When working with Claude Code, the repositories should be cloned to:
```
~/therxos-backend/    # Backend Express app
~/therxos-frontend/   # Frontend Next.js app
```

Connect to services:
1. **Supabase** - Get connection string from Supabase dashboard → Settings → Database
2. **Railway** - GitHub integration auto-deploys on push
3. **Vercel** - Run `vercel link` to connect existing project
