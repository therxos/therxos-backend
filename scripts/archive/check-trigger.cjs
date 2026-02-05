const https = require('https');
function fetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({hostname: u.hostname, path: u.pathname + u.search, method: opts.method || 'GET', headers: opts.headers || {}}, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve({status: res.statusCode, data: JSON.parse(data)}));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
(async () => {
  const BASE = 'https://discerning-mindfulness-production-07d5.up.railway.app';
  const login = await fetch(BASE + '/api/auth/login', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({email:'stan@therxos.com',password:'demo1234'})});
  const token = login.data.token;
  if (!token) { console.log('Login failed', login.data); return; }
  const r = await fetch(BASE + '/api/admin/triggers', {headers:{Authorization:'Bearer '+token}});
  const triggers = Array.isArray(r.data) ? r.data : (r.data.triggers || r.data.data || []);
  console.log('Response type:', typeof r.data, Array.isArray(r.data) ? 'array' : Object.keys(r.data).join(','));
  const icos = triggers.filter(t => t.display_name && t.display_name.toLowerCase().includes('icosapent'));
  icos.forEach(t => console.log(JSON.stringify({name:t.display_name, expected_qty:t.expected_qty, expected_days:t.expected_days_supply})));
})();
