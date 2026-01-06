# TheRxOS V2 - Project Documentation

## Overview

TheRxOS is a multi-tenant SaaS platform for independent pharmacies to identify and capture clinical opportunity revenue. The system scans prescription claims data, identifies therapeutic interchange opportunities, missing therapies, and optimization opportunities, then tracks them through submission to insurance approval.

**Owner:** Stan ("Pharmacy Stan") - 23 years pharmacy experience
**Brand:** TheRxOS (The Rx Operating System)

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
│   │   │   ├── opportunities.js # Opportunity CRUD
│   │   │   ├── patients.js     # Patient queries
│   │   │   └── prospects.js    # Sales funnel & Stripe
│   │   ├── utils/
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

## Known Issues / TODO

- [ ] Logout causes client-side error (React hydration)
- [ ] `/change-password` page returns 404
- [ ] Stripe integration incomplete (needs keys)
- [ ] Gmail polling for auto-capture not implemented
- [ ] Aracoma Drug RX30 data import pending

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
