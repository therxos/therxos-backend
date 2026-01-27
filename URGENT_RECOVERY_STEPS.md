# URGENT: Recover Deleted Bravo Opportunities

## The Problem
Approximately 37+ Completed opportunities were lost during deduplication.

## Recovery Options

### Option 1: Supabase Point-in-Time Recovery (PITR) - BEST OPTION
**IMPORTANT: This requires Pro plan. Check if you have PITR enabled.**

1. Go to: https://supabase.com/dashboard/project/vjqkgkpfkpdmfajiprkp
2. Navigate to: Database → Backups
3. Look for "Point-in-Time Recovery"
4. Restore to: **January 27, 2026 at 9:00 AM EST** (before deduplication)

### Option 2: Daily Backup Restore
If PITR is not available, there may be daily backups:
1. Go to Database → Backups
2. Look for the most recent daily backup before today
3. Restore from that backup

### Option 3: Export Current + Restore from Backup
To preserve new data while recovering old:
1. Export current opportunities table
2. Create a new project with PITR restore
3. Export opportunities from restored DB
4. Compare and identify missing Completed opportunities
5. INSERT only the missing ones back

### Current State (for comparison after restore)
As of now, Bravo has:
- Completed: 53
- Approved: 56
- Submitted: 110
- Total actioned: 631

User reported having 90+ Completed before, so ~37+ are missing.

## Prevention (Already Implemented)
1. Database trigger `protect_actioned_opportunities` now PREVENTS deletion of any opportunity with status != 'Not Submitted'
2. Audit log `opportunity_audit_log` now tracks ALL changes permanently
3. CLAUDE.md updated with critical rules about never deleting actioned opportunities

## Commands to Run After Restore
After restoring, verify with:
```sql
SELECT status, COUNT(*)
FROM opportunities
WHERE pharmacy_id = 'bd8e10ee-dbef-4b81-b2fa-3ff2a9269518'
GROUP BY status;
```
