import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

// Import route handlers
import authRoutes from './routes/auth.js';
import clientsRoutes from './routes/clients.js';
import patientsRoutes from './routes/patients.js';
import opportunitiesRoutes from './routes/opportunities.js';
import analyticsRoutes from './routes/analytics.js';

dotenv.config({ path: '.env.local' });

const app = express();
const PORT = process.env.PORT || 3001;

// ===== MIDDLEWARE =====
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== HEALTH CHECK =====
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString()
  });
});

// ===== ROUTE HANDLERS =====
app.use('/api/auth', authRoutes);
app.use('/api/clients', clientsRoutes);
app.use('/api/patients', patientsRoutes);
app.use('/api/opportunities', opportunitiesRoutes);
app.use('/api/analytics', analyticsRoutes);

// ===== ERROR HANDLER =====
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

// ===== START SERVER =====
app.listen(PORT, () => {
  console.log(`✓ Server running on port ${PORT}`);
  console.log(`✓ Environment: ${process.env.NODE_ENV}`);
  console.log(`✓ API available at http://localhost:${PORT}`);
});
