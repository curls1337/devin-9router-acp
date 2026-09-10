/**
 * 9Router Connection & Model Health Check
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

function loadEnv(envPath) {
  const env = {};
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq !== -1) {
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim().replace(/^["'](.*)["']$/, '$1');
        env[key] = val;
      }
    }
  }
  return env;
}

const env = loadEnv(path.join(__dirname, '.env'));
const host = env.ROUTER_HOST || process.env.ROUTER_HOST || '127.0.0.1';
const port = parseInt(env.ROUTER_PORT || process.env.ROUTER_PORT || '8080');
const apiKey = env.ROUTER_API_KEY || process.env.ROUTER_API_KEY || '';
const defaultModel = env.ROUTER_MODEL || process.env.ROUTER_MODEL || 'claude-3-7-sonnet';

console.log('========================================================');
console.log('  🔍 Menguji Koneksi ke 9Router Gateway');
console.log('========================================================');
console.log(`- Target Gateway : http://${host}:${port}`);
console.log(`- Default Model  : ${defaultModel}`);
console.log(`- API Key        : ${apiKey ? (apiKey.slice(0, 8) + '...' + apiKey.slice(-4)) : '(Belum diisi)'}`);
console.log('--------------------------------------------------------');
console.log('Sedang menghubungi server 9Router...');

const startTime = Date.now();

const req = http.request({
  hostname: host,
  port: port,
  path: '/v1/models',
  method: 'GET',
  headers: {
    'Authorization': `Bearer ${apiKey}`
  },
  timeout: 8000
}, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    const duration = Date.now() - startTime;
    if (res.statusCode === 200) {
      try {
        const parsed = JSON.parse(body);
        const models = Array.isArray(parsed.data) ? parsed.data : [];
        console.log(`✅ KONEKSI BERHASIL! (Respon: ${res.statusCode} OK dalam ${duration}ms)`);
        console.log(`Ditemukan ${models.length} model aktif di 9Router:`);
        console.log('');
        models.slice(0, 10).forEach((m, idx) => {
          console.log(`  ${idx + 1}. [${m.id}] (${m.owned_by || 'ai'})`);
        });
        if (models.length > 10) {
          console.log(`  ... dan ${models.length - 10} model lainnya.`);
        }
        console.log('');
        console.log('Server 9Router siap digunakan untuk Devin Desktop!');
        console.log('========================================================');
      } catch (e) {
        console.log(`⚠️ Berhasil terhubung tapi format JSON tidak sesuai:`, e.message);
      }
    } else {
      console.error(`❌ HTTP Error: ${res.statusCode} ${res.statusMessage}`);
      console.error(`Body: ${body}`);
      process.exit(1);
    }
  });
});

req.on('error', (err) => {
  console.error(`❌ GAGAL MENGHUBUNGI SERVER: ${err.message}`);
  console.error(`Pastikan koneksi internet aktif dan host ${host}:${port} tidak diblokir firewall.`);
  process.exit(1);
});

req.on('timeout', () => {
  req.destroy();
  console.error('❌ TIMEOUT: Server tidak merespon dalam 8 detik.');
  process.exit(1);
});

req.end();
