require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { sequelize } = require('./models');

// Middleware
const { errorHandler, auditLog } = require('./middleware/auth');

// Routes
const authRoutes = require('./routes/auth');
const accountRoutes = require('./routes/accounts');
const transactionRoutes = require('./routes/transactions');
const transferRoutes = require('./routes/transfers');
const beneficiaryRoutes = require('./routes/beneficiaries');

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3001;
const path = require('path');

// ===== Middleware Setup =====

// Serve frontend static files
app.use(express.static(path.join(__dirname, '../../client/public')));
app.use(express.static(path.join(__dirname, '../../client/src')));

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
    credentials: true,
  })
);

// Audit logging
app.use(auditLog);

// ===== Health Check =====

/**
 * GET /
 * Health check endpoint
 */
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'OK',
    service: 'Qona MBS API',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /health
 * Detailed health check
 */
app.get('/health', async (req, res) => {
  try {
    // Check database connection
    await sequelize.authenticate();

    res.status(200).json({
      status: 'OK',
      service: 'Qona MBS API',
      database: 'Connected',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(503).json({
      status: 'ERROR',
      service: 'Qona MBS API',
      database: 'Disconnected',
      error: error.message,
    });
  }
});

// ===== API Routes =====

/**
 * Authentication routes
 */
app.use('/api/auth', authRoutes);

/**
 * Account management routes
 */
app.use('/api/accounts', accountRoutes);

/**
 * Transaction routes
 */
app.use('/api/transactions', transactionRoutes);

/**
 * Transfer routes
 */
app.use('/api/transfers', transferRoutes);

/**
 * Beneficiary routes
 */
app.use('/api/beneficiaries', beneficiaryRoutes);

// ===== SPA Fallback =====

/**
 * Serve index.html for all non-API routes (SPA routing)
 */
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../../client/public/index.html'));
});

// ===== 404 Handler =====

app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    path: req.path,
    method: req.method,
  });
});

// ===== Error Handler =====

app.use(errorHandler);

// ===== Database & Server Setup =====

/**
 * Sync database and start server
 */
const startServer = async () => {
  try {
    // Test database connection
    await sequelize.authenticate();
    console.log('✅ Database connection established');

    // Sync models (creates tables if they don't exist)
    // In production, use migrations instead
    if (process.env.NODE_ENV === 'development') {
      // For SQLite, use force: true on first run to avoid index issues
      const isSQLite = process.env.DB_TYPE === 'sqlite';
      await sequelize.sync({ force: false, alter: !isSQLite });
      console.log('✅ Database models synced');
    }

    // Start listening
    app.listen(PORT, () => {
      console.log(`
╔═══════════════════════════════════════════════════════════╗
║     Qona DT SACCO Mobile Banking System - API Server      ║
║                                                           ║
║  Status: Running                                          ║
║  URL:    http://localhost:${PORT}                              ║
║  Health: http://localhost:${PORT}/health                       ║
║                                                           ║
║  API Documentation:                                       ║
║  GET  /                     - Service info                ║
║  GET  /health               - Health check                ║
║  POST /api/auth/register    - Register member             ║
║  POST /api/auth/login       - Login                       ║
║  POST /api/auth/logout      - Logout                      ║
║  GET  /api/auth/me          - Get current user            ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
      `);
    });
  } catch (error) {
    console.error('❌ Failed to start server:');
    console.error(error);
    process.exit(1);
  }
};

// Start server if this file is run directly
if (require.main === module) {
  startServer();
}

module.exports = app;
