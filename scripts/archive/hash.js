import bcrypt from 'bcryptjs';

const password = 'demo12345';  // 9 characters
const hash = await bcrypt.hash(password, 12);
console.log('Password hash:', hash);
