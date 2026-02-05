require('dotenv').config();

console.log('NOTIFYRE_API_KEY set:', !!process.env.NOTIFYRE_API_KEY);
console.log('Key length:', process.env.NOTIFYRE_API_KEY?.length || 0);

// Check if SDK is available
try {
  const sdk = require('notifyre-nodejs-sdk');
  console.log('SDK available:', !!sdk);
  console.log('SDK exports:', Object.keys(sdk));
} catch (e) {
  console.log('SDK error:', e.message);
}
