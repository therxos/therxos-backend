// Database connection for TheRxOS V2
import pg from 'pg';

const { Pool } = pg;

// PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Test connection on startup
pool.on('connect', () => {
  const dbHost = process.env.DATABASE_URL?.split('@')[1]?.split(':')[0] || 'unknown';
  console.log(`Database connection established to: ${dbHost}`);
});

pool.on('error', (err) => {
  console.error('Unexpected database error:', err);
});

/**
 * Execute a query with automatic connection handling
 */
export async function query(text, params) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    
    if (duration > 1000) {
      console.warn('Slow query detected', { duration, text: text.substring(0, 100) });
    }
    
    return result;
  } catch (error) {
    console.error('Database query error:', { error: error.message, text: text.substring(0, 100) });
    throw error;
  }
}

/**
 * Execute a transaction with multiple queries
 */
export async function transaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Get a single row by ID
 */
export async function getById(table, idColumn, id) {
  const result = await query(
    `SELECT * FROM ${table} WHERE ${idColumn} = $1`,
    [id]
  );
  return result.rows[0] || null;
}

/**
 * Insert a row and return the inserted record
 */
export async function insert(table, data) {
  const columns = Object.keys(data);
  const values = Object.values(data);
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  
  const result = await query(
    `INSERT INTO ${table} (${columns.join(', ')}) 
     VALUES (${placeholders}) 
     RETURNING *`,
    values
  );
  return result.rows[0];
}

/**
 * Update a row by ID
 */
export async function update(table, idColumn, id, data) {
  const columns = Object.keys(data);
  const values = Object.values(data);
  const setClause = columns.map((col, i) => `${col} = $${i + 2}`).join(', ');
  
  const result = await query(
    `UPDATE ${table} 
     SET ${setClause} 
     WHERE ${idColumn} = $1 
     RETURNING *`,
    [id, ...values]
  );
  return result.rows[0];
}

/**
 * Health check for database connection
 */
export async function healthCheck() {
  try {
    const result = await query('SELECT NOW() as time');
    return { status: 'healthy', timestamp: result.rows[0].time };
  } catch (error) {
    return { status: 'unhealthy', error: error.message };
  }
}

export { pool };
export default { query, transaction, insert, update, getById, healthCheck };
