import 'dotenv/config';
import db from './src/database/index.js';

const result = await db.query(`
  SELECT email, first_name, last_name, role, must_change_password
  FROM users
  WHERE client_id = '5d572581-15a5-4910-b76e-322a05af5d00'
`);
for (const r of result.rows) {
  console.log('email:', r.email, '| name:', r.first_name, r.last_name, '| role:', r.role, '| must_change_pw:', r.must_change_password);
}

process.exit(0);
