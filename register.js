/**
 * 9Router ACP Auto-Registrar for Devin Desktop
 * 
 * Otomatis mendaftarkan atau memperbarui konfigurasi agent 9Router
 * ke registry Devin Desktop / Windsurf di komputer lokal.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Helper to load .env manually
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

const scriptDir = __dirname;
const envFile = path.join(scriptDir, '.env');
const envConfig = loadEnv(envFile);

const routerHost = envConfig.ROUTER_HOST || process.env.ROUTER_HOST || '127.0.0.1';
const routerPort = envConfig.ROUTER_PORT || process.env.ROUTER_PORT || '8080';
const routerApiKey = envConfig.ROUTER_API_KEY || process.env.ROUTER_API_KEY || '';
const routerModel = envConfig.ROUTER_MODEL || process.env.ROUTER_MODEL || 'claude-3-7-sonnet';

const serverJsPath = path.resolve(scriptDir, 'server.js');
const nodeBin = process.execPath; // Path ke node.exe aktif

console.log('========================================================');
console.log('  🚀 9Router Auto-Registrar untuk Devin Desktop');
console.log('========================================================');
console.log(`- Folder ACP Server : ${scriptDir}`);
console.log(`- File server.js    : ${serverJsPath}`);
console.log(`- Node executable   : ${nodeBin}`);
console.log(`- Model Default     : ${routerModel}`);
console.log(`- Host Gateway      : ${routerHost}:${routerPort}`);
console.log('--------------------------------------------------------');

// Deteksi platform OS
const platform = os.platform();
let osKey = 'windows-x86_64';
if (platform === 'darwin') {
  osKey = os.arch() === 'arm64' ? 'darwin-arm64' : 'darwin-x86_64';
} else if (platform === 'linux') {
  osKey = os.arch() === 'arm64' ? 'linux-arm64' : 'linux-x86_64';
} else if (platform === 'win32') {
  osKey = os.arch() === 'arm64' ? 'windows-arm64' : 'windows-x86_64';
}

// Konfigurasi Agent sesuai standar ACP Registry Devin / Windsurf
const agentEntry = {
  id: "nine-router",
  name: "9Router AI",
  version: "1.0.0",
  description: "Devin ACP bridge connected to 9Router Proxy (Auto-Vision & Hermes QA)",
  distribution: {
    binary: {
      [osKey]: {
        archive: "",
        cmd: nodeBin,
        args: [serverJsPath],
        env: {
          ROUTER_HOST: routerHost,
          ROUTER_PORT: routerPort,
          ROUTER_API_KEY: routerApiKey,
          ROUTER_MODEL: routerModel
        }
      }
    }
  }
};

// Target file registry
const homeDir = os.homedir();
const targets = [
  path.join(homeDir, '.windsurf', 'acp', 'registry.json'),
  path.join(homeDir, '.devin', 'registry.json')
];

let successCount = 0;

for (const registryPath of targets) {
  try {
    const parentDir = path.dirname(registryPath);
    if (!fs.existsSync(parentDir)) {
      // Jika parent dir belum ada (misal .devin), hanya buat jika .windsurf
      if (registryPath.includes('.windsurf')) {
        fs.mkdirSync(parentDir, { recursive: true });
      } else {
        continue;
      }
    }

    let registryData = { version: "1.0.0", agents: [] };
    if (fs.existsSync(registryPath)) {
      try {
        const raw = fs.readFileSync(registryPath, 'utf8');
        registryData = JSON.parse(raw);
        if (!Array.isArray(registryData.agents)) {
          registryData.agents = [];
        }
      } catch (err) {
        console.warn(`[WARN] File ${registryPath} rusak atau kosong, membuat ulang.`);
        registryData = { version: "1.0.0", agents: [] };
      }
    }

    // Perbarui atau tambahkan nine-router
    const existingIndex = registryData.agents.findIndex(a => a && a.id === 'nine-router');
    if (existingIndex !== -1) {
      registryData.agents[existingIndex] = agentEntry;
      console.log(`[OK] Memperbarui agen 'nine-router' di: ${registryPath}`);
    } else {
      registryData.agents.push(agentEntry);
      console.log(`[OK] Menambahkan agen 'nine-router' baru ke: ${registryPath}`);
    }

    fs.writeFileSync(registryPath, JSON.stringify(registryData, null, 2), 'utf8');
    successCount++;
  } catch (err) {
    console.error(`[ERROR] Gagal menulis ke ${registryPath}:`, err.message);
  }
}

console.log('--------------------------------------------------------');
if (successCount > 0) {
  console.log('✅ SUKSES! 9Router berhasil didaftarkan ke Devin Desktop.');
  console.log('');
  console.log('Langkah berikutnya:');
  console.log('1. Buka aplikasi Devin Desktop');
  console.log('2. Buka Settings -> tab "Agents"');
  console.log('3. Pastikan "9Router AI" sudah tercentang / terpilih');
  console.log('4. (Opsional) Tekan "Reload ACP Connections" jika Devin sedang terbuka');
  console.log('========================================================');
} else {
  console.error('❌ Gagal mendaftarkan ke registry. Silakan cek izin folder.');
  process.exit(1);
}
