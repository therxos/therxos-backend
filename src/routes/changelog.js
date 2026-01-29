// changelog.js - Client-facing changelog/updates API
import express from 'express';

const router = express.Router();

// Client-visible changelog entries (manually curated from CHANGELOG.md)
// Only include [CLIENT] tagged items - things that affect their experience
const CHANGELOG_ENTRIES = [
  {
    date: '2026-01-29',
    version: '2.6.0',
    entries: [
      {
        type: 'feature',
        title: 'Insurance Info on Intake',
        description: 'Enter BIN, PCN, and GROUP before scanning a patient intake image. Edit insurance info in results before adding to queue.'
      },
      {
        type: 'feature',
        title: 'Group Opportunities by Drug',
        description: 'New "Drug" option in Group By dropdown — see all patients for a given recommended drug in one view'
      },
      {
        type: 'improvement',
        title: 'Fax Template Improvements',
        description: 'Clinical rationale text now displays at proper size on fax PDFs'
      }
    ]
  },
  {
    date: '2026-01-19',
    version: '2.4.1',
    entries: [
      {
        type: 'feature',
        title: 'What\'s New Sidebar',
        description: 'See recent platform updates directly in your dashboard sidebar'
      }
    ]
  },
  {
    date: '2026-01-19',
    version: '2.4.0',
    entries: [
      {
        type: 'feature',
        title: 'Live Dashboard Stats',
        description: 'Website now shows real-time opportunity breakdowns by category'
      }
    ]
  },
  {
    date: '2026-01-18',
    version: '2.3.0',
    entries: [
      {
        type: 'feature',
        title: 'Coverage Scan Timestamps',
        description: 'Triggers now show when they were last scanned for insurance coverage'
      },
      {
        type: 'feature',
        title: 'Medicare Part D Data',
        description: 'CMS formulary data now displayed in trigger details'
      }
    ]
  },
  {
    date: '2026-01-16',
    version: '2.2.0',
    entries: [
      {
        type: 'improvement',
        title: 'Improved Data Quality',
        description: 'Better handling of prescriber and drug data validation'
      }
    ]
  },
  {
    date: '2026-01-15',
    version: '2.1.0',
    entries: [
      {
        type: 'feature',
        title: 'GP per Rx Analytics',
        description: 'New analytics breakdown by insurance BIN and GROUP'
      },
      {
        type: 'feature',
        title: 'Monthly Reports Export',
        description: 'Download your monthly reports as CSV files'
      }
    ]
  },
  {
    date: '2026-01-04',
    version: '2.0.0',
    entries: [
      {
        type: 'feature',
        title: 'Medicare Formulary Integration',
        description: 'Coverage lookup now includes Medicare Part D formulary data'
      }
    ]
  }
];

// GET /api/changelog - Get recent updates for clients
router.get('/', (req, res) => {
  const limit = parseInt(req.query.limit) || 5;

  // Return most recent entries
  const recentEntries = CHANGELOG_ENTRIES.slice(0, limit);

  res.json({
    updates: recentEntries,
    total: CHANGELOG_ENTRIES.length
  });
});

// GET /api/changelog/latest - Get just the latest update
router.get('/latest', (req, res) => {
  const latest = CHANGELOG_ENTRIES[0] || null;
  res.json({ update: latest });
});

export default router;
