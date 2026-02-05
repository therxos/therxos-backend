import 'dotenv/config';
import db from './src/database/index.js';

const result = await db.query(`
  UPDATE users
  SET password_hash = '$2a$12$6Y2LnxLsFTIckpCqI/gQWeABAi9svAkPfw6kIMDYqakgL9J/qkaga'
  WHERE email = '2401pharmacy@gmail.com'
  RETURNING email, first_name, last_name, role
`);
console.log('Updated:', result.rows[0]);
process.exit(0);
