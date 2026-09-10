/**
 * 9Router ACP Server for Devin Desktop
 * 
 * Features:
 * 1. Dynamic Model Synchronization from 9Router API
 * 2. 5 Modes (Code, Smart, Ask, Plan, Bypass Permissions) matching native Devin UI
 * 3. Autonomous Coding & Workspace Tools (list_directory, read_file, write_file, execute_command)
 * 4. Full Multimodal Image Support:
 *    - Advertises promptCapabilities.image: true in ACP initialize handshake
 *    - Captures pasted/attached images from Devin Desktop chat (Base64)
 *    - Forwards image_url to 9Router vision models (Claude, Gemini, GPT-4o, etc.)
 * 5. Full MCP (Model Context Protocol) Integration:
 *    - Advertises mcpCapabilities (http, sse) in initialize handshake
 *    - Connects to MCP servers provided by Devin in session/new or mcp_config.json
 *    - Dynamically exposes MCP tools to 9Router LLM
 *    - Dispatches tool calls to MCP servers
 * 6. Streaming Agent Messages & Tool Calls formatted for Devin UI
 */

const readline = require('readline');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { exec, spawnSync } = require('child_process');

// Native .env file loader (Zero external dependencies)
function loadEnvFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx !== -1) {
          const key = trimmed.slice(0, eqIdx).trim();
          const val = trimmed.slice(eqIdx + 1).trim().replace(/^["'](.*)["']$/, '$1');
          if (!process.env[key]) {
            process.env[key] = val;
          }
        }
      }
    }
  } catch (e) {}
}

// Automatically load .env from current directory or parent
loadEnvFile(path.join(__dirname, '.env'));

// Configuration
const CONFIG = {
  remoteHermesUrl: process.env.REMOTE_HERMES_URL || process.env.REMOTE_SKILLS_URL || "",
  extraSkillsPath: process.env.EXTRA_SKILLS_PATH || "",
  host: process.env.ROUTER_HOST || '127.0.0.1',
  port: parseInt(process.env.ROUTER_PORT || '8080'),
  apiKey: process.env.ROUTER_API_KEY || '',
  defaultModel: process.env.ROUTER_MODEL || 'claude-3-7-sonnet',
  systemPrompt: process.env.SYSTEM_PROMPT || 
    'You are an expert autonomous AI software engineer assistant connected to Devin Desktop via 9Router. ' +
    'You have direct terminal execution capabilities via the `execute_command` tool (PowerShell on Windows), file editing tools (`write_file`, `edit_file`, `read_file`, `list_directory`, `search_files`, `find_files`), and connected MCP tools. ' +
    'CRITICAL RULE: You HAVE direct access to run terminal commands on the user workspace via `execute_command`. ' +
    'NEVER tell the user "Saya tidak dapat langsung menginstal atau menjalankan perintah di mesin lokal Anda" or act like a read-only chatbot! ' +
    'When the user asks you to install packages, setup dependencies, run migrations, docker, build, or start services, you MUST directly invoke `execute_command` to execute the commands and do the installation for them! ' +
    'You are fully capable of understanding images and diagrams attached in the conversation. ' +
    'Always inspect the workspace files and read relevant documents when the user asks questions about their project.'
};

// Log file for troubleshooting
const LOG_FILE = path.join(__dirname, 'acp_debug.log');

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch (e) {}
}

log('====================================================');
log('9Router ACP Agent starting with 5 Modes, Image Support & MCP...');
log(`Target 9Router Endpoint: http://${CONFIG.host}:${CONFIG.port}/v1`);
log('====================================================');

// Cached models list
let cachedModels = [
  { value: 'ag/gemini-3.8-flash-high', name: 'Gemini 3.8 Flash High', description: 'Fast and smart Google model' },
  { value: 'ag/gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash Medium', description: 'Balanced Google model' },
  { value: 'ag/gemini-3.8-flash-low', name: 'Gemini 3.8 Flash Low', description: 'Lightweight Google model' },
  { value: 'ag/claude-sonnet-4-6', name: 'Claude Sonnet 4.6', description: 'Anthropic high intelligence' },
  { value: 'ag/claude-opus-4-6-thinking', name: 'Claude Opus 4.6 Thinking', description: 'Anthropic deep reasoning' },
  { value: 'ag/gpt-oss-120b-medium', name: 'GPT OSS 120B', description: 'Open weights powerhouse' },
  { value: 'nvidia/deepseek-ai/deepseek-v4-pro', name: 'DeepSeek V4 Pro', description: 'DeepSeek advanced reasoning' },
  { value: 'mistral/codestral-latest', name: 'Codestral Latest', description: 'Mistral specialized coding model' }
];

function formatModelName(modelId) {
  const parts = modelId.split('/');
  const rawName = parts[parts.length - 1];
  return rawName
    .split(/[-_.]/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// Fetch models dynamically from 9Router
function syncModelsFrom9Router() {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: CONFIG.host,
      port: CONFIG.port,
      path: '/v1/models',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${CONFIG.apiKey}`
      },
      timeout: 10000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const parsed = JSON.parse(data);
            if (parsed && Array.isArray(parsed.data) && parsed.data.length > 0) {
              cachedModels = parsed.data.map(m => {
                const modelId = m.id;
                return {
                  value: modelId,
                  name: formatModelName(modelId),
                  description: m.owned_by ? `Provider: ${m.owned_by}` : modelId
                };
              });
              log(`Successfully synced ${cachedModels.length} models from 9Router`);
            }
          } catch (e) {
            log('Error parsing 9Router models:', e.message);
          }
        } else {
          log(`Failed to fetch models from 9Router, HTTP ${res.statusCode}`);
        }
        resolve();
      });
    });

    req.on('error', (err) => {
      log('Error syncing models from 9Router:', err.message);
      resolve();
    });

    req.end();
  });
}

// Background sync on startup
syncModelsFrom9Router();

// Config options helper for Devin UI
async function getConfigOptions(currentMode = 'code', currentModel = CONFIG.defaultModel) {
  const modelOptions = cachedModels.map(m => ({
    value: m.value,
    name: m.name || m.value,
    description: m.description || m.value
  }));

  if (!modelOptions.some(m => m.value === currentModel)) {
    modelOptions.unshift({
      value: currentModel,
      name: formatModelName(currentModel),
      description: currentModel
    });
  }

  return [
    {
      id: 'mode',
      name: 'Mode',
      type: 'select',
      currentValue: currentMode,
      options: [
        { value: 'code', name: 'Code', description: 'Write and edit code' },
        { value: 'smart', name: 'Smart', description: 'Auto-approve actions the model judges safe' },
        { value: 'ask', name: 'Ask', description: 'Answer questions without code changes' },
        { value: 'plan', name: 'Plan', description: 'Plan changes before implementing' },
        { value: 'bypass', name: 'Bypass Permissions', description: 'Auto-approve all tool calls' }
      ]
    },
    {
      id: 'model',
      name: 'Model',
      type: 'select',
      currentValue: currentModel,
      options: modelOptions
    }
  ];
}

// Built-in Workspace Tools definitions
const WORKSPACE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List all files and subdirectories in a given folder (relative to workspace root or absolute path).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Folder path to list, e.g. "." or "src"' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read content of any file. Automatically parses and extracts text from code, text, Markdown, PDF documents, Excel spreadsheets (.xlsx), and Images (.jpg/.png via OCR).',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to the file to read' }
        },
        required: ['file_path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a file with new content in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'File path to write' },
          content: { type: 'string', description: 'Full content of the file' }
        },
        required: ['file_path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'execute_command',
      description: 'Execute a terminal command (PowerShell on Windows) in the workspace directory.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command to run' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Surgically replace an exact matching block of text in a file with new content. Always prefer this over write_file when modifying existing files.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to the file to edit' },
          old_text: { type: 'string', description: 'The exact existing block of text to replace' },
          new_text: { type: 'string', description: 'The new replacement block of text' }
        },
        required: ['file_path', 'old_text', 'new_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search for text or regex patterns across files in the workspace (ripgrep / grep style).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'String or regex pattern to search for' },
          path: { type: 'string', description: 'Subdirectory path to restrict search (optional)' },
          is_regex: { type: 'boolean', description: 'Set true if query is a regular expression (optional)' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'find_files',
      description: 'Find files across workspace by filename, extension, or pattern (e.g. "*.tsx", "schema.prisma", "auth").',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'File name pattern or extension' }
        },
        required: ['pattern']
      }
    }
  }
];

// Smart multi-format file reader
function smartReadFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  // 1. PDF Documents: Extract text pages
  if (ext === '.pdf') {
    const pyCode = [
      'import pypdf, sys',
      'reader = pypdf.PdfReader(sys.argv[1])',
      'lines = [f"=== PDF Document: {len(reader.pages)} Pages ==="]',
      'for i, page in enumerate(reader.pages[:20]):',
      '    t = page.extract_text() or ""',
      '    lines.append(f"--- PAGE {i+1} ---")',
      '    lines.append(t)',
      'if len(reader.pages) > 20:',
      '    lines.append(f"... ({len(reader.pages) - 20} more pages truncated) ...")',
      'sys.stdout.buffer.write(("\\n".join(lines)).encode("utf-8"))'
    ].join('\n');

    const res = spawnSync('python', ['-c', pyCode, filePath], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });
    if (res.status === 0 && res.stdout) return res.stdout;
    log('PDF extract fallback error:', res.stderr);
  }

  // 2. Excel Spreadsheets: Extract sheets and sample tables
  if (ext === '.xlsx' || ext === '.xls') {
    const pyCode = [
      'import pandas as pd, sys',
      'excel_path = sys.argv[1]',
      'xls = pd.ExcelFile(excel_path)',
      'lines = [f"=== Excel Spreadsheet: {len(xls.sheet_names)} Sheet(s): {xls.sheet_names} ==="]',
      'for name in xls.sheet_names:',
      '    df = pd.read_excel(excel_path, sheet_name=name)',
      '    lines.append(f"\\n--- Sheet: {name} (Rows: {len(df)}, Cols: {len(df.columns)}) ---")',
      '    lines.append(f"Columns: {df.columns.tolist()}")',
      '    lines.append("Sample Data (first 10 rows):")',
      '    lines.append(df.head(10).to_string())',
      'sys.stdout.buffer.write(("\\n".join(lines)).encode("utf-8"))'
    ].join('\n');

    const res = spawnSync('python', ['-c', pyCode, filePath], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });
    if (res.status === 0 && res.stdout) return res.stdout;
    log('Excel extract fallback error:', res.stderr);
  }

  // 3. Image Files: OCR text extraction
  if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
    const pyCode = [
      'import easyocr, sys',
      'reader = easyocr.Reader(["en", "id"], gpu=True)',
      'results = reader.readtext(sys.argv[1])',
      'lines = [f"=== Image OCR ({sys.argv[1]}): {len(results)} text blocks detected ==="]',
      'for bbox, text, prob in results:',
      '    lines.append(f"[{prob:.2f}] {text}")',
      'sys.stdout.buffer.write(("\\n".join(lines)).encode("utf-8"))'
    ].join('\n');

    const res = spawnSync('python', ['-c', pyCode, filePath], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });
    if (res.status === 0 && res.stdout) return res.stdout;
    log('Image OCR fallback error:', res.stderr);
  }

  // 4. Default / Text / Source Code files
  const stat = fs.statSync(filePath);
  if (stat.size > 2 * 1024 * 1024) {
    return `File is too large (${stat.size} bytes). Please inspect smaller parts.`;
  }
  return fs.readFileSync(filePath, 'utf8');
}


// Helper to sanitize & deduplicate tool names (fixes streaming delta duplication like list_directorylist_directory)
function resolveToolName(rawName) {
  if (!rawName) return '';
  const knownTools = ['list_directory', 'read_file', 'write_file', 'edit_file', 'search_files', 'find_files', 'execute_command'];
  for (const t of knownTools) {
    if (rawName === t + t || rawName === t || rawName.startsWith(t)) {
      return t;
    }
  }
  return rawName;
}


// Auto-detect skills in workspace (.devin/skills, .agents/skills, skills)
function discoverWorkspaceSkills(cwd) {
  const userHome = process.env.USERPROFILE || process.env.HOME || '';
  const searchRoots = [
    // 1. Project-local skills (Highest priority)
    path.join(cwd, '.devin', 'skills'),
    path.join(cwd, '.agents', 'skills'),
    path.join(cwd, 'skills'),
    // 2. Bundled Portable Skills (Shipped directly inside this ACP package)
    path.join(__dirname, 'bundled-skills'),
    // 3. User Global Devin Skills
    path.join(userHome, '.devin', 'skills')
  ];

  // 4. Custom Extra Skills Path from .env (e.g. EXTRA_SKILLS_PATH=D:\my-skills)
  if (CONFIG.extraSkillsPath && fs.existsSync(CONFIG.extraSkillsPath)) {
    searchRoots.push(CONFIG.extraSkillsPath);
  }

  // 5. Local Hermes Agent Library if available on this system
  const hermesBase = process.env.HERMES_SKILLS_PATH || path.join(userHome, '.hermes', 'hermes-agent', 'skills');
  if (fs.existsSync(hermesBase)) {
    searchRoots.push(
      path.join(hermesBase, 'software-development'),
      path.join(hermesBase, 'dogfood'),
      path.join(hermesBase, 'devops'),
      path.join(hermesBase, 'diagramming')
    );
  }
  const hermesOptional = path.join(userHome, '.hermes', 'hermes-agent', 'optional-skills', 'dogfood');
  if (fs.existsSync(hermesOptional)) {
    searchRoots.push(hermesOptional);
  }

  const skillsMap = new Map();

  for (const dir of searchRoots) {
    try {
      if (!fs.existsSync(dir)) continue;

      // Check if the directory itself is a skill (e.g. skills/dogfood/SKILL.md)
      const directSkillMd = path.join(dir, 'SKILL.md');
      if (fs.existsSync(directSkillMd)) {
        const skillName = path.basename(dir);
        if (!skillsMap.has(skillName)) {
          try {
            const raw = fs.readFileSync(directSkillMd, 'utf8');
            let desc = '';
            const matchDesc = raw.match(/description:\s*["']?([^"'\r\n]+)["']?/i);
            if (matchDesc) desc = matchDesc[1].trim();
            skillsMap.set(skillName, {
              name: skillName,
              desc: desc || 'Domain skill',
              relPath: path.resolve(directSkillMd).replace(/\\/g, '/')
            });
          } catch (e) {}
        }
      }

      // Check subdirectories
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const it of items) {
        if (it.isDirectory()) {
          const skillMd = path.join(dir, it.name, 'SKILL.md');
          if (fs.existsSync(skillMd) && !skillsMap.has(it.name)) {
            try {
              const raw = fs.readFileSync(skillMd, 'utf8');
              let desc = '';
              const matchDesc = raw.match(/description:\s*["']?([^"'\r\n]+)["']?/i);
              if (matchDesc) desc = matchDesc[1].trim();
              skillsMap.set(it.name, {
                name: it.name,
                desc: desc || 'Domain skill',
                relPath: path.resolve(skillMd).replace(/\\/g, '/')
              });
            } catch (e) {}
          }
        }
      }
    } catch (e) {}
  }

  // 6. Include Remote Hermes Skills if cached
  if (remoteSkillsCache && remoteSkillsCache.length > 0) {
    for (const rs of remoteSkillsCache) {
      if (!skillsMap.has(rs.name)) {
        skillsMap.set(rs.name, rs);
      }
    }
  }

  const result = Array.from(skillsMap.values());
  log(`[Skills Engine] Discovered ${result.length} available skill(s) across project and global libraries.`);
  return result;
}

// Helper to execute workspace tools locally
async function executeWorkspaceTool(toolName, args, workspaceCwd) {
  const cwd = workspaceCwd || process.cwd();
  log(`Executing tool: ${toolName} with args:`, JSON.stringify(args), `in cwd: ${cwd}`);

  if (toolName === 'list_directory') {
    const targetPath = path.isAbsolute(args.path || '.') ? args.path : path.join(cwd, args.path || '.');
    try {
      if (!fs.existsSync(targetPath)) {
        return `Directory not found: ${args.path}`;
      }
      const items = fs.readdirSync(targetPath, { withFileTypes: true });
      const list = items.map(item => {
        const type = item.isDirectory() ? 'DIR' : 'FILE';
        let size = 0;
        try {
          if (!item.isDirectory()) {
            size = fs.statSync(path.join(targetPath, item.name)).size;
          }
        } catch (e) {}
        return `[${type}] ${item.name}${size ? ` (${size} bytes)` : ''}`;
      });
      return list.join('\n') || '(Directory is empty)';
    } catch (err) {
      return `Error listing directory: ${err.message}`;
    }
  }

  if (toolName === 'read_file') {
    const filePath = path.isAbsolute(args.file_path) ? args.file_path : path.join(cwd, args.file_path);
    try {
      if (!fs.existsSync(filePath)) {
        return `File not found: ${args.file_path}`;
      }
      return smartReadFile(filePath);
    } catch (err) {
      return `Error reading file: ${err.message}`;
    }
  }

  if (toolName === 'write_file') {
    const filePath = path.isAbsolute(args.file_path) ? args.file_path : path.join(cwd, args.file_path);
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(filePath, args.content, 'utf8');
      return `Successfully wrote ${args.content.length} characters to ${args.file_path}`;
    } catch (err) {
      return `Error writing file: ${err.message}`;
    }
  }


  if (toolName === 'edit_file') {
    const filePath = path.isAbsolute(args.file_path) ? args.file_path : path.join(cwd, args.file_path);
    try {
      if (!fs.existsSync(filePath)) {
        return `File not found: ${args.file_path}`;
      }
      const original = fs.readFileSync(filePath, 'utf8');
      if (!original.includes(args.old_text)) {
        return `Error: old_text was not found in ${args.file_path}. Please read the file first to ensure exact match.`;
      }
      const updated = original.replace(args.old_text, args.new_text);
      fs.writeFileSync(filePath, updated, 'utf8');
      return `Successfully replaced text in ${args.file_path}`;
    } catch (err) {
      return `Error editing file: ${err.message}`;
    }
  }

  if (toolName === 'search_files') {
    const targetDir = args.path ? (path.isAbsolute(args.path) ? args.path : path.join(cwd, args.path)) : cwd;
    const query = args.query;
    const isRegex = !!args.is_regex;
    try {
      const results = [];
      const ignoreDirs = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', 'coverage']);
      
      function walk(dir) {
        if (results.length >= 35) return;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          if (results.length >= 35) break;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            if (!ignoreDirs.has(e.name) && !e.name.startsWith('.')) {
              walk(full);
            }
          } else if (e.isFile()) {
            try {
              const stat = fs.statSync(full);
              if (stat.size < 500 * 1024) {
                const text = fs.readFileSync(full, 'utf8');
                const relPath = path.relative(cwd, full);
                const lines = text.split('\n');
                for (let i = 0; i < lines.length; i++) {
                  const line = lines[i];
                  let match = false;
                  if (isRegex) {
                    try { match = new RegExp(query, 'i').test(line); } catch (re) {}
                  } else {
                    match = line.toLowerCase().includes(query.toLowerCase());
                  }
                  if (match) {
                    results.push(`${relPath}:${i + 1}: ${line.trim().slice(0, 150)}`);
                    if (results.length >= 35) break;
                  }
                }
              }
            } catch (e) {}
          }
        }
      }
      walk(targetDir);
      return results.join('\n') || `No matches found for "${query}"`;
    } catch (err) {
      return `Error searching files: ${err.message}`;
    }
  }

  if (toolName === 'find_files') {
    const pattern = (args.pattern || '').toLowerCase();
    try {
      const results = [];
      const ignoreDirs = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', 'coverage']);
      function walk(dir) {
        if (results.length >= 50) return;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          if (results.length >= 50) break;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            if (!ignoreDirs.has(e.name) && !e.name.startsWith('.')) {
              walk(full);
            }
          } else if (e.isFile()) {
            if (e.name.toLowerCase().includes(pattern) || (pattern.startsWith('*.') && e.name.toLowerCase().endsWith(pattern.slice(1)))) {
              results.push(path.relative(cwd, full));
            }
          }
        }
      }
      walk(cwd);
      return results.join('\n') || `No files matching pattern "${args.pattern}"`;
    } catch (err) {
      return `Error finding files: ${err.message}`;
    }
  }

  if (toolName === 'execute_command') {
    return new Promise((resolve) => {
      exec(args.command, { cwd, timeout: 60000 }, (error, stdout, stderr) => {
        let out = '';
        if (stdout) out += stdout;
        if (stderr) out += (out ? '\n--- STDERR ---\n' : '') + stderr;
        if (error) out += `\nCommand failed with code ${error.code || 1}: ${error.message}`;
        resolve(out.trim() || '(No output)');
      });
    });
  }

  return `Unknown tool: ${toolName}`;
}

// -----------------------------------------------------------------------------
// MCP (Model Context Protocol) Client Integration
// -----------------------------------------------------------------------------
const sessionMcpClients = new Map(); // sessionId -> { tools: [], clients: Map<string, { client, originalName, serverName }> }

async function setupMcpServersForSession(sessionId, incomingServers, workspaceCwd) {
  let servers = [...(incomingServers || [])];

  // Also check standard MCP config files if incoming is empty
  if (servers.length === 0) {
    const candidates = [
      path.join(process.env.USERPROFILE || '', '.codeium', 'windsurf', 'mcp_config.json'),
      path.join(process.env.USERPROFILE || '', '.codeium', 'windsurf-next', 'mcp_config.json'),
      path.join(process.env.APPDATA || '', 'devin', 'User', 'mcp_config.json'),
      path.join(workspaceCwd || '', 'mcp_config.json'),
      path.join(workspaceCwd || '', '.mcp.json')
    ];

    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) {
          const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
          if (raw && raw.mcpServers) {
            for (const [name, cfg] of Object.entries(raw.mcpServers)) {
              if (cfg && !servers.some(s => s.name === name)) {
                servers.push({
                  name,
                  ...cfg
                });
              }
            }
          }
        }
      } catch (e) {
        log('Error reading MCP config from candidate path:', p, e.message);
      }
    }
  }

  log(`Setting up ${servers.length} MCP server(s) for session ${sessionId}`);

  const mcpTools = [];
  const clientMap = new Map();

  try {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');

    for (const srv of servers) {
      const srvName = srv.name || 'unnamed_mcp';
      try {
        log(`Connecting to MCP server: ${srvName} (type: ${srv.type || 'stdio'})`);
        let transport = null;

        if (srv.type === 'sse' || srv.url) {
          transport = new SSEClientTransport(new URL(srv.url));
        } else {
          // stdio
          const envObj = {};
          if (srv.env) {
            if (Array.isArray(srv.env)) {
              for (const e of srv.env) {
                if (e.name) envObj[e.name] = e.value;
              }
            } else if (typeof srv.env === 'object') {
              Object.assign(envObj, srv.env);
            }
          }
          transport = new StdioClientTransport({
            command: srv.command,
            args: srv.args || [],
            env: { ...process.env, ...envObj }
          });
        }

        const client = new Client(
          { name: `devin-acp-${srvName}`, version: '1.0.0' },
          { capabilities: {} }
        );

        await client.connect(transport);
        const { tools } = await client.listTools();
        log(`MCP server ${srvName} connected with ${tools ? tools.length : 0} tools`);

        if (tools && Array.isArray(tools)) {
          for (const t of tools) {
            const registeredName = `mcp_${srvName}_${t.name}`.replace(/[^a-zA-Z0-9_-]/g, '_');
            mcpTools.push({
              type: 'function',
              function: {
                name: registeredName,
                description: `[MCP: ${srvName}] ${t.description || ''}`,
                parameters: t.inputSchema || { type: 'object', properties: {} }
              }
            });
            clientMap.set(registeredName, { client, originalName: t.name, serverName: srvName });
          }
        }
      } catch (srvErr) {
        log(`Failed to connect MCP server ${srvName}:`, srvErr.message);
      }
    }
  } catch (sdkErr) {
    log('Failed to load MCP SDK in server:', sdkErr.message);
  }

  sessionMcpClients.set(sessionId, {
    tools: mcpTools,
    clients: clientMap
  });

  return mcpTools;
}

async function executeMcpTool(sessionId, funcName, args) {
  const sessionData = sessionMcpClients.get(sessionId);
  if (!sessionData || !sessionData.clients.has(funcName)) {
    return `Error: Tool ${funcName} not found in MCP registry`;
  }
  const { client, originalName, serverName } = sessionData.clients.get(funcName);
  log(`Calling MCP tool ${originalName} on server ${serverName} with args:`, JSON.stringify(args));
  try {
    const res = await client.callTool({
      name: originalName,
      arguments: args
    });
    if (res && res.content && Array.isArray(res.content)) {
      return res.content.map(c => {
        if (c.type === 'text') return c.text;
        if (c.type === 'image') return `[Image content: ${c.mimeType}]`;
        return JSON.stringify(c);
      }).join('\n');
    }
    return JSON.stringify(res);
  } catch (err) {
    log(`MCP tool call failed for ${funcName}:`, err.message);
    return `Error executing MCP tool: ${err.message}`;
  }
}

// Session store: sessionId -> { cwd, mode, model, history }
const sessions = new Map();
const activePrompts = new Map(); // sessionId -> { promptId, abort, cancelled }

// Ensure strict pairing of assistant tool_calls and tool results for Gemini API compatibility
function sanitizeToolCallPairing(messages) {
  const result = [];
  const pendingCalls = new Set();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'assistant') {
      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (tc.id) pendingCalls.add(tc.id);
        }
      }
      result.push(msg);
    } else if (msg.role === 'tool') {
      if (pendingCalls.has(msg.tool_call_id)) {
        pendingCalls.delete(msg.tool_call_id);
        result.push(msg);
      } else {
        log('Pruning dropped orphaned tool message: ' + msg.tool_call_id);
      }
    } else {
      if (pendingCalls.size > 0) {
        for (const callId of pendingCalls) {
          result.push({
            role: 'tool',
            tool_call_id: callId,
            content: 'Operation acknowledged.'
          });
        }
        pendingCalls.clear();
      }
      result.push(msg);
    }
  }

  for (const callId of pendingCalls) {
    result.push({
      role: 'tool',
      tool_call_id: callId,
      content: 'Operation acknowledged.'
    });
  }

  return result;
}

// Smart Rolling Window & Tool Pruning to prevent 1M token overflow and Google 400 INVALID_ARGUMENT
function pruneSessionHistory(history, aggressive = false) {
  if (!Array.isArray(history) || history.length === 0) return [];

  // Step 1: Truncate oversized tool outputs in historical turns
  const processed = history.map((msg, idx) => {
    if (msg.role === 'tool' && typeof msg.content === 'string') {
      const isRecent = idx >= history.length - 4;
      const limit = aggressive ? 1000 : (isRecent ? 3500 : 1200);
      if (msg.content.length > limit) {
        const headLen = Math.floor(limit * 0.6);
        const tailLen = Math.floor(limit * 0.35);
        return {
          ...msg,
          content: msg.content.slice(0, headLen) +
            '\n... [output diringkas ' + (msg.content.length - limit) + ' karakter untuk efisiensi konteks] ...\n' +
            msg.content.slice(-tailLen)
        };
      }
    }
    return msg;
  });

  // Step 2: Calculate total character volume (~4 chars per token)
  let totalChars = 0;
  for (const m of processed) {
    totalChars += (typeof m.content === 'string' ? m.content.length : 800);
  }

  const maxCharBudget = aggressive ? 120000 : 280000;
  const maxMessageCount = aggressive ? 12 : 24;

  if (totalChars > maxCharBudget || processed.length > maxMessageCount) {
    log('[Prune] Compacted history: totalChars=' + totalChars + ', messages=' + processed.length + ', aggressive=' + aggressive);
    const firstMsg = processed[0]; // Retain original user goal
    const windowSize = aggressive ? 8 : 14;
    let recentWindow = processed.slice(-windowSize);

    // Never start window with an orphaned tool result
    while (recentWindow.length > 0 && recentWindow[0].role === 'tool') {
      recentWindow.shift();
    }

    const summaryBridge = [
      {
        role: 'user',
        content: '[Catatan Sistem: Tahap awal pengerjaan telah diselesaikan dengan aman. Riwayat tengah dipadatkan otomatis untuk menjaga efisiensi token dan performa respons. Silakan lanjutkan pengerjaan berdasarkan konteks kode dan file terbaru.]'
      },
      {
        role: 'assistant',
        content: 'Saya telah memahami seluruh konteks sebelumnya dan akan langsung melanjutkan pengerjaan dari titik terakhir.'
      }
    ];

    const pruned = [firstMsg, ...summaryBridge, ...recentWindow];
    return sanitizeToolCallPairing(pruned);
  }

  return sanitizeToolCallPairing(processed);
}

// Helper to send JSON-RPC message to Devin via stdout
function send(msg) {
  const payload = JSON.stringify(msg) + '\n';
  process.stdout.write(payload);
  log('OUT >>>', msg.method || `res(id:${msg.id})`, msg.result ? 'SUCCESS' : '');
}

// Save incoming screenshot/image to local workspace folder
function saveImageToDisk(workspaceCwd, dataUrl) {
  try {
    if (!dataUrl) return null;
    const match = dataUrl.match(/^data:image\/([a-zA-Z0-9-+.]+);base64,(.+)$/);
    if (!match) return null;
    const mimeExt = match[1] === 'jpeg' ? 'jpg' : match[1];
    const b64Data = match[2];
    const uploadDir = path.join(workspaceCwd, '.devin_attachments');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    const filename = 'screenshot_' + Date.now() + '.' + mimeExt;
    const filePath = path.join(uploadDir, filename);
    fs.writeFileSync(filePath, Buffer.from(b64Data, 'base64'));
    log('[Vision Bridge] Saved image to: ' + filePath);
    return path.relative(workspaceCwd, filePath).replace(/\\/g, '/');
  } catch (e) {
    log('[Vision Bridge] Error saving image to disk: ' + e.message);
    return null;
  }
}

// Auto-Vision Bridge: Analyzes attached images using Gemini 3.8 Flash on 9Router
// Extracts all console errors, UI text, and visual states so coding models (like Claude) receive complete visual context
async function describeImagesWithVision(imageBlocks) {
  if (!imageBlocks || imageBlocks.length === 0) return '';
  log('[Vision Bridge] Analyzing ' + imageBlocks.length + ' image(s) with Gemini Vision...');

  return new Promise((resolve) => {
    const payload = {
      model: 'ag/gemini-3.8-flash-medium',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'You are an expert software engineer and UI diagnostic vision specialist. Carefully examine the attached screenshot(s).\n' +
                'Transcribe and report:\n' +
                '1. All error messages, stack traces, console logs, red alerts, network errors, and HTTP status codes (e.g. 404, 500, etc.).\n' +
                '2. Exact UI elements visible: active page title, form fields, dropdowns, buttons, tabs, modal dialogs.\n' +
                '3. Browser URL or file paths if shown.\n' +
                'Provide a direct, high-fidelity technical transcription to help an AI engineer diagnose and fix the issue immediately.'
            },
            ...imageBlocks
          ]
        }
      ],
      stream: false
    };

    const postData = JSON.stringify(payload);
    const req = http.request({
      hostname: CONFIG.host,
      port: CONFIG.port,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + CONFIG.apiKey,
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 30000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const desc = json.choices?.[0]?.message?.content || '';
          log('[Vision Bridge] Vision analysis complete (' + desc.length + ' chars)');
          resolve(desc);
        } catch (e) {
          log('[Vision Bridge] Failed to parse vision response: ' + e.message);
          resolve('');
        }
      });
    });

    req.on('error', (err) => {
      log('[Vision Bridge] Request error: ' + err.message);
      resolve('');
    });

    req.on('timeout', () => {
      req.destroy();
      log('[Vision Bridge] Request timed out');
      resolve('');
    });

    req.write(postData);
    req.end();
  });
}

// Call 9Router OpenAI-compatible Chat Completions API with Tool Call & Multimodal support
function call9Router(modelName, messages, tools, onChunk, onThought, onDone, onError) {
  const modelToUse = modelName || CONFIG.defaultModel;
  log(`Calling 9Router with model: ${modelToUse}, tools count: ${tools ? tools.length : 0}`);

  const payload = {
    model: modelToUse,
    messages: [
      { role: 'system', content: CONFIG.systemPrompt },
      ...messages
    ],
    stream: true
  };

  if (tools && tools.length > 0) {
    payload.tools = tools;
    payload.tool_choice = 'auto';
  }

  const postData = JSON.stringify(payload);

  const req = http.request({
    hostname: CONFIG.host,
    port: CONFIG.port,
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CONFIG.apiKey}`,
      'Content-Length': Buffer.byteLength(postData)
    },
    timeout: 120000
  }, (res) => {
    if (res.statusCode !== 200) {
      let errData = '';
      res.on('data', c => errData += c);
      res.on('end', () => onError(new Error(`9Router HTTP ${res.statusCode}: ${errData}`)));
      return;
    }

    let buffer = '';
    const toolCallsMap = new Map();

    res.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // Keep partial line in buffer

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data: ')) continue;
        const dataStr = line.slice(6);
        if (dataStr === '[DONE]') continue;

        try {
          const json = JSON.parse(dataStr);
          const delta = json.choices?.[0]?.delta;
          if (!delta) continue;

          // Streaming thinking / reasoning content
          if (delta.reasoning_content || delta.reasoning) {
            const thoughtText = delta.reasoning_content || delta.reasoning;
            if (typeof onThought === 'function') {
              onThought(thoughtText);
            }
          }

          // Streaming text
          if (delta.content) {
            onChunk(delta.content);
          }

          // Streaming tool calls
          if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCallsMap.has(idx)) {
                toolCallsMap.set(idx, {
                  id: tc.id || `call_${idx}_${Date.now()}`,
                  type: 'function',
                  function: { name: '', arguments: '' }
                });
              }
              const existing = toolCallsMap.get(idx);
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) {
                if (!existing.function.name) {
                  existing.function.name = tc.function.name;
                } else if (existing.function.name !== tc.function.name && !existing.function.name.includes(tc.function.name)) {
                  existing.function.name += tc.function.name;
                }
              }
              if (tc.function?.arguments) {
                existing.function.arguments += tc.function.arguments;
              }
            }
          }
        } catch (e) {
          // Ignore JSON parse errors on partial stream chunks
        }
      }
    });

    res.on('end', () => {
      const toolCalls = Array.from(toolCallsMap.values())
        .filter(tc => tc.function.name)
        .map(tc => ({
          ...tc,
          function: {
            ...tc.function,
            name: resolveToolName(tc.function.name)
          }
        }));
      onDone(toolCalls.length > 0 ? toolCalls : null);
    });
  });

  req.on('error', (err) => {
    onError(err);
  });

  req.on('timeout', () => {
    req.destroy();
    onError(new Error('9Router request timed out'));
  });

  req.write(postData);
  req.end();

  return {
    abort: () => {
      try {
        req.destroy();
      } catch (e) {}
    }
  };
}


// Remote Hermes Skills Cache & Sync
let remoteSkillsCache = [];
function syncRemoteHermesSkills() {
  if (!CONFIG.remoteHermesUrl) return;
  try {
    log(`[Remote Skills] Syncing skills from remote endpoint: ${CONFIG.remoteHermesUrl}`);
    const parsedUrl = new URL(CONFIG.remoteHermesUrl);
    const client = parsedUrl.protocol === 'https:' ? require('https') : http;
    const req = client.get(CONFIG.remoteHermesUrl, { timeout: 10000 }, (res) => {
      if (res.statusCode !== 200) {
        log(`[Remote Skills] Server responded with HTTP ${res.statusCode}`);
        return;
      }
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const items = Array.isArray(parsed) ? parsed : (parsed.skills || []);
          remoteSkillsCache = items.map(s => ({
            name: s.name,
            desc: s.desc || s.description || 'Remote Hermes Skill',
            relPath: s.url || s.path || `${CONFIG.remoteHermesUrl}/${s.name}`
          }));
          log(`[Remote Skills] Successfully cached ${remoteSkillsCache.length} remote skill(s).`);
        } catch (e) {
          log('[Remote Skills] Failed to parse remote response: ' + e.message);
        }
      });
    });
    req.on('error', (err) => {
      log('[Remote Skills] Connection error: ' + err.message);
    });
    req.end();
  } catch (e) {
    log('[Remote Skills] Invalid URL format: ' + CONFIG.remoteHermesUrl);
  }
}

if (CONFIG.remoteHermesUrl) {
  syncRemoteHermesSkills();
}

// Stdio Readline interface (JSON-RPC over NDJSON)
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on('line', async (rawLine) => {
  const line = rawLine.trim();
  if (!line) return;

  let msg;
  try {
    msg = JSON.parse(line);
  } catch (err) {
    log('Failed to parse incoming line:', line);
    return;
  }

  log('IN <<<', msg.method || `id:${msg.id}`, JSON.stringify(msg.params || {}).slice(0, 160));

  const id = msg.id;
  const method = msg.method;
  const params = msg.params || {};

  // 1b. Cancellation: session/cancel or $/cancel_request (Interruption from Devin UI)
  if (method === 'session/cancel' || method === '$/cancel_request') {
    const sessionId = params.sessionId;
    log('Incoming cancellation request for session: ' + sessionId);
    const active = activePrompts.get(sessionId);
    if (active) {
      active.cancelled = true;
      if (active.abort) {
        try { active.abort(); } catch (e) {}
      }
      if (active.promptId) {
        send({
          jsonrpc: '2.0',
          id: active.promptId,
          result: { stopReason: 'cancelled' }
        });
      }
      activePrompts.delete(sessionId);
    }
    if (id !== undefined) {
      send({
        jsonrpc: '2.0',
        id,
        result: {}
      });
    }
    return;
  }

  // 1. Handshake: initialize
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: 1,
        agentInfo: {
          name: '9Router AI Agent',
          version: '1.0.0',
          description: `9Router Gateway Agent (${CONFIG.host}:${CONFIG.port})`
        },
        agentCapabilities: {
          loadSession: false,
          mcpCapabilities: {
            http: true,
            sse: true
          },
          promptCapabilities: {
            embeddedContext: true,
            image: true,
            audio: false
          }
        }
      }
    });
    return;
  }

  // 2. Session creation: session/new
  if (method === 'session/new') {
    const sessionId = 'sess_' + crypto.randomBytes(8).toString('hex');
    const selectedMode = 'code';
    const selectedModel = CONFIG.defaultModel;
    const workspaceCwd = params.cwd || process.cwd();

    log(`Creating new session ${sessionId} with cwd: ${workspaceCwd}`);

    sessions.set(sessionId, {
      cwd: workspaceCwd,
      mode: selectedMode,
      model: selectedModel,
      history: []
    });

    // Initialize MCP servers for this session in background
    setupMcpServersForSession(sessionId, params.mcpServers || [], workspaceCwd);

    const configOpts = await getConfigOptions(selectedMode, selectedModel);

    send({
      jsonrpc: '2.0',
      id,
      result: {
        sessionId,
        configOptions: configOpts
      }
    });
    return;
  }

  // 3. Set Config Option: session/set_config_option
  if (method === 'session/set_config_option') {
    const sessionId = params.sessionId;
    const configId = params.configId;
    const value = params.value;

    const session = sessions.get(sessionId) || {
      cwd: process.cwd(),
      mode: 'code',
      model: CONFIG.defaultModel,
      history: []
    };

    if (configId === 'mode' && value) {
      session.mode = value;
      log(`Session ${sessionId} mode switched to: ${value}`);
    } else if (configId === 'model' && value) {
      session.model = value;
      log(`Session ${sessionId} model switched to: ${value}`);
    }
    sessions.set(sessionId, session);

    const configOpts = await getConfigOptions(session.mode, session.model);

    send({
      jsonrpc: '2.0',
      id,
      result: {
        configOptions: configOpts
      }
    });
    return;
  }

  // 4. User prompt: session/prompt
  if (method === 'session/prompt') {
    const sessionId = params.sessionId;
    let session = sessions.get(sessionId);
    if (!session) {
      session = {
        cwd: process.cwd(),
        mode: 'code',
        model: CONFIG.defaultModel,
        history: []
      };
      sessions.set(sessionId, session);
    }

    // Extract user prompt text and image blocks
    let rawTextParts = [];
    let imageBlocks = [];

    const parseBlock = (b) => {
      if (!b) return;
      if (typeof b === 'string') {
        rawTextParts.push(b);
        return;
      }
      const item = b.content || b;
      if (item.type === 'text' && item.text) {
        rawTextParts.push(item.text);
      } else if (item.type === 'image') {
        const mime = item.mimeType || 'image/png';
        const b64Data = item.data || '';
        if (b64Data) {
          log(`Extracted image block (${mime}, length: ${b64Data.length})`);
          imageBlocks.push({
            type: 'image_url',
            image_url: {
              url: b64Data.startsWith('data:') ? b64Data : `data:${mime};base64,${b64Data}`
            }
          });
        }
      } else if (item.text) {
        rawTextParts.push(item.text);
      }
    };

    if (typeof params.prompt === 'string') {
      parseBlock(params.prompt);
    } else if (Array.isArray(params.prompt)) {
      for (const block of params.prompt) {
        parseBlock(block);
      }
    } else if (typeof params.prompt === 'object') {
      parseBlock(params.prompt);
    }

    const userText = rawTextParts.join('\n') || (imageBlocks.length > 0 ? 'Please analyze this attached image.' : 'Hello');

    log(`Prompt received in session ${sessionId} (mode: ${session.mode}, model: ${session.model}, images: ${imageBlocks.length}): "${userText.slice(0, 100)}"`);

    // Prepare mode-specific instruction prefix
    let modeInstruction = '';
    if (session.mode === 'ask') {
      modeInstruction = '\n[CURRENT MODE: ASK]\n- Answer questions, explain code, and inspect the workspace without making ANY code changes or executing terminal commands.\n- File writing and terminal execution tools are disabled.\n';
    } else if (session.mode === 'plan') {
      modeInstruction = '\n[CURRENT MODE: PLAN]\n- Formulate a thorough, step-by-step implementation plan formatted in Markdown.\n- Inspect the workspace as needed, but do NOT modify or create files yet.\n';
    } else if (session.mode === 'smart') {
      modeInstruction = '\n[CURRENT MODE: SMART]\n- Safe, read-only inspection operations proceed automatically.\n- Exercise extreme precision and care when modifying project files.\n';
    } else if (session.mode === 'bypass') {
      modeInstruction = '\n[CURRENT MODE: BYPASS PERMISSIONS]\n- All tool calls and file modifications are fully auto-approved.\n';
    } else {
      modeInstruction = '\n[CURRENT MODE: CODE]\n- Write and edit code autonomously to fulfill the user task.\n';
    }

    // Prepare system context with current workspace CWD
    // Discover skills in workspace automatically
    const availableSkills = discoverWorkspaceSkills(session.cwd);
    let skillsSection = '';
    if (availableSkills.length > 0) {
      skillsSection = '\n[Available Workspace Skills]\n' +
        'You have access to specialized skills in this project folder:\n' +
        availableSkills.map(s => `- ${s.name}: ${s.desc} (Location: ${s.relPath})`).join('\n') +
        '\n\nCRITICAL RULE: If the user\'s request involves tasks matching any of the available skills above (e.g., UI/UX design, architecture, specific patterns), you MUST first use read_file to inspect its SKILL.md and strictly follow its instructions!\n';
    }

    const workspaceInfo = `[Current Workspace: ${session.cwd}]\n${modeInstruction}${skillsSection}\n`;

    let visionAnalysisText = '';
    let savedImagesList = [];

    if (imageBlocks.length > 0) {
      // 1. Save images to local workspace folder
      for (let i = 0; i < imageBlocks.length; i++) {
        const blk = imageBlocks[i];
        const rawUrl = blk.image_url?.url || '';
        const savedRelPath = saveImageToDisk(session.cwd, rawUrl);
        if (savedRelPath) {
          savedImagesList.push(savedRelPath);
        }
      }

      // 2. If model is Claude or non-Gemini, bridge vision via Gemini Vision on 9Router
      const isNativeVision = session.model.toLowerCase().includes('gemini');
      if (!isNativeVision) {
        log(`[Vision Bridge] Bridging vision for ${session.model} using Gemini 3.8 Flash...`);
        const visionNoticeId = 'msg_vision_' + crypto.randomBytes(6).toString('hex');
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: visionNoticeId,
              content: {
                type: 'text',
                text: '🔍 *[Vision Bridge] Menganalisis screenshot via Gemini Vision...*\n\n'
              }
            }
          }
        });

        visionAnalysisText = await describeImagesWithVision(imageBlocks);
      }
    }

    let augmentedUserText = userText;
    if (visionAnalysisText) {
      augmentedUserText += `\n\n[Visual Screenshot Analysis & Error Log]:\n${visionAnalysisText}`;
    }
    if (savedImagesList.length > 0) {
      augmentedUserText += `\n[Local Screenshot File(s) in Workspace]: ${savedImagesList.join(', ')}`;
    }

    let userMessageContent;
    const isNativeVision = session.model.toLowerCase().includes('gemini');
    if (imageBlocks.length > 0 && isNativeVision) {
      userMessageContent = [
        { type: 'text', text: workspaceInfo + augmentedUserText },
        ...imageBlocks
      ];
    } else {
      userMessageContent = workspaceInfo + augmentedUserText;
    }

    session.history.push({ role: 'user', content: userMessageContent });
    session.history = pruneSessionHistory(session.history);

    const activePromptState = { promptId: id, abort: null, cancelled: false };
    activePrompts.set(sessionId, activePromptState);

    // Autonomous Agent Loop (supports up to 100 continuous turns)
    // Unlimited autonomous turns (default: 0 = completely UNLIMITED)
    const maxTurns = parseInt(process.env.MAX_TURNS || '0');
    const runAgentTurn = async (turnCount = 0) => {
      if (maxTurns > 0 && turnCount >= maxTurns) {
        log(`Reached max agent turns limit (${maxTurns})`);
        const limitMsgId = 'msg_limit_' + crypto.randomBytes(6).toString('hex');
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: limitMsgId,
              content: {
                type: 'text',
                text: `\n\n⏸️ **Batas langkah otonom (${maxTurns} langkah) tercapai.**\nSemua perubahan kode hingga tahap ini sudah tersimpan dengan aman. Silakan ketik **"lanjutkan"** untuk meneruskan pengerjaan sisa tugas.`
              }
            }
          }
        });
        send({
          jsonrpc: '2.0',
          id,
          result: { stopReason: 'end_turn' }
        });
        return;
      }

      const currentMessageId = 'msg_' + crypto.randomBytes(8).toString('hex');
      let assistantText = '';

      // Determine tools to use based on mode
      let toolsToUse = [];
      const sessionMcp = sessionMcpClients.get(sessionId);
      const mcpTools = sessionMcp ? sessionMcp.tools : [];

      if (session.mode === 'ask' || session.mode === 'plan') {
        // Read-only tools only
        toolsToUse = WORKSPACE_TOOLS.filter(t => ['list_directory', 'read_file', 'search_files', 'find_files'].includes(t.function.name));
      } else {
        // Full tools: workspace + MCP
        toolsToUse = [...WORKSPACE_TOOLS, ...mcpTools];
      }

      if (activePromptState.cancelled) {
        log('Agent turn aborted due to cancellation for session: ' + sessionId);
        activePrompts.delete(sessionId);
        return;
      }

      session.history = pruneSessionHistory(session.history);

      activePromptState.abort = call9Router(
        session.model,
        session.history,
        toolsToUse,
        // onChunk: stream text directly to Devin Desktop with messageId
        (chunk) => {
          assistantText += chunk;
          send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                messageId: currentMessageId,
                content: {
                  type: 'text',
                  text: chunk
                }
              }
            }
          });
        },
        // onThought: stream reasoning thoughts to collapsible accordion
        (thoughtChunk) => {
          send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId,
              update: {
                sessionUpdate: 'agent_thought_chunk',
                messageId: currentMessageId,
                content: {
                  type: 'text',
                  text: thoughtChunk
                }
              }
            }
          });
        },
        // onDone: check if tool calls were triggered
        async (toolCalls) => {
          if (toolCalls && toolCalls.length > 0) {
            log(`Model requested ${toolCalls.length} tool call(s) in turn ${turnCount}`);

            // Push assistant response with tool_calls to history
            session.history.push({
              role: 'assistant',
              content: assistantText || null,
              tool_calls: toolCalls
            });

            // Execute each tool call and notify Devin UI
            for (const tc of toolCalls) {
              const funcName = resolveToolName(tc.function.name);
              let parsedArgs = {};
              try {
                parsedArgs = JSON.parse(tc.function.arguments || '{}');
              } catch (e) {
                parsedArgs = { raw: tc.function.arguments };
              }

              // Notify Devin UI of tool_call start
              send({
                jsonrpc: '2.0',
                method: 'session/update',
                params: {
                  sessionId,
                  update: {
                    sessionUpdate: 'tool_call',
                    toolCallId: tc.id,
                    title: `${funcName}(${JSON.stringify(parsedArgs)})`,
                    name: funcName,
                    status: 'in_progress',
                    rawInput: parsedArgs
                  }
                }
              });

              // Execute tool against local workspace or MCP server
              let result = '';
              if (['list_directory', 'read_file', 'write_file', 'edit_file', 'search_files', 'find_files', 'execute_command'].includes(funcName)) {
                result = await executeWorkspaceTool(funcName, parsedArgs, session.cwd);
              } else {
                result = await executeMcpTool(sessionId, funcName, parsedArgs);
              }

              // Notify Devin UI of tool completion
              send({
                jsonrpc: '2.0',
                method: 'session/update',
                params: {
                  sessionId,
                  update: {
                    sessionUpdate: 'tool_call_update',
                    toolCallId: tc.id,
                    title: `${funcName}`,
                    status: 'completed',
                    rawOutput: typeof result === 'string' && result.length > 5000 ? result.slice(0, 5000) + '... (truncated)' : result
                  }
                }
              });

              // Push tool result into conversation history
              session.history.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: String(result)
              });
            }

            sessions.set(sessionId, session);

            // Re-invoke model with tool results
            await runAgentTurn(turnCount + 1);
          } else {
            // Normal end of turn without tool calls
            session.history.push({ role: 'assistant', content: assistantText });
            sessions.set(sessionId, session);

            activePrompts.delete(sessionId);
            send({
              jsonrpc: '2.0',
              id,
              result: {
                stopReason: 'end_turn'
              }
            });
          }
        },
        // onError
        (err) => {
          log('Error during 9Router request:', err.message);
          send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                messageId: currentMessageId,
                content: {
                  type: 'text',
                  text: `\n\n⚠️ Error connecting to 9Router (${session.model}): ${err.message}`
                }
              }
            }
          });

          // Auto-recovery: prune history aggressively so next prompt / 'lanjutkan' succeeds immediately
          session.history = pruneSessionHistory(session.history, true);
          sessions.set(sessionId, session);
          activePrompts.delete(sessionId);

          send({
            jsonrpc: '2.0',
            id,
            result: {
              stopReason: 'error'
            }
          });
        }
      );
    };

    await runAgentTurn();
    return;
  }

  // Fallback for unknown method
  send({
    jsonrpc: '2.0',
    id,
    error: {
      code: -32601,
      message: `Method ${method} not implemented`
    }
  });
});
