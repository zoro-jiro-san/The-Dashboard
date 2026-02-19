#!/usr/bin/env node
/**
 * Daily Dashboard Update Script
 * Fetches on-chain balances and updates JSON data files.
 * Runs daily via GitHub Actions cron at 9 AM UTC.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// ── Config ───────────────────────────────────────────────────────────────────

const RPC = {
  solana: process.env.SOLANA_RPC || 'https://solana-devnet.g.alchemy.com/v2/W9o65SbKMxxjFJSoW9Ia2f3KRLiQdP4I',
  base:   process.env.BASE_RPC   || 'https://base-sepolia.g.alchemy.com/v2/W9o65SbKMxxjFJSoW9Ia2f3KRLiQdP4I',
  eth:    process.env.ETH_RPC    || 'https://eth-sepolia.g.alchemy.com/v2/W9o65SbKMxxjFJSoW9Ia2f3KRLiQdP4I',
};

const WALLETS = {
  solana:   process.env.SOLANA_WALLET || '925Ss7kt3Gy7oEohuxzBGt9HKtdAbFSooAveYekqvC3v',
  base:     process.env.BASE_WALLET   || '0x3DE91DCF9D4d949237Bb77c3b2273878f9186f82',
  ethereum: process.env.ETH_WALLET    || '0xFf4b06E931C69e6BDCac8e59298bB570e8D19f0e',
};

const DATA_DIR = path.join(__dirname, '..', 'data');
const SNAPSHOTS_FILE  = path.join(DATA_DIR, 'daily-snapshots.json');
const LATEST_FILE     = path.join(DATA_DIR, 'latest.json');
const ACTIVITY_FILE   = path.join(DATA_DIR, 'activity-log.json');

// ── Helpers ──────────────────────────────────────────────────────────────────

function postJSON(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function getJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error')); }
      });
    }).on('error', reject);
  });
}

function readJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJSON(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ── Balance Fetchers ─────────────────────────────────────────────────────────

async function fetchSolanaBalance() {
  try {
    const res = await postJSON(RPC.solana, {
      jsonrpc: '2.0',
      id: 1,
      method: 'getBalance',
      params: [WALLETS.solana],
    });
    const lamports = res.result?.value ?? 0;
    const sol = (lamports / 1e9).toFixed(4);
    log(`Solana: ${sol} SOL`);
    return `${sol} SOL`;
  } catch (err) {
    log(`Solana fetch error: ${err.message}`);
    return '0.0000 SOL';
  }
}

async function fetchEVMBalance(rpcUrl, address, label) {
  try {
    const res = await postJSON(rpcUrl, {
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getBalance',
      params: [address, 'latest'],
    });
    const wei = parseInt(res.result || '0x0', 16);
    const eth = (wei / 1e18).toFixed(6);
    log(`${label}: ${eth} ETH`);
    return `${eth} ETH`;
  } catch (err) {
    log(`${label} fetch error: ${err.message}`);
    return '0.000000 ETH';
  }
}

async function fetchEthPrice() {
  try {
    const data = await getJSON(
      'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd'
    );
    const price = data?.ethereum?.usd ?? 2500;
    log(`ETH price: $${price}`);
    return price;
  } catch {
    log('ETH price fetch failed, using default $2500');
    return 2500;
  }
}

// ── Core Logic ───────────────────────────────────────────────────────────────

async function fetchBalances() {
  const [solana, base, eth, ethPrice] = await Promise.all([
    fetchSolanaBalance(),
    fetchEVMBalance(RPC.base, WALLETS.base, 'Base Sepolia'),
    fetchEVMBalance(RPC.eth, WALLETS.ethereum, 'ETH Sepolia'),
    fetchEthPrice(),
  ]);
  return { solana, base, eth, ethPrice };
}

function calcDailyChange(previous, current) {
  function extractNum(str) {
    return parseFloat((str || '0').replace(/[^0-9.]/g, '')) || 0;
  }
  const prevSol  = extractNum(previous?.solana_devnet);
  const prevBase = extractNum(previous?.base_sepolia);
  const prevEth  = extractNum(previous?.eth_sepolia);
  const curSol   = extractNum(current.solana_devnet);
  const curBase  = extractNum(current.base_sepolia);
  const curEth   = extractNum(current.eth_sepolia);
  const fmt = (n, decimals) => (n >= 0 ? '+' : '') + n.toFixed(decimals);
  return {
    solana_devnet: fmt(curSol - prevSol, 4),
    base_sepolia:  fmt(curBase - prevBase, 6),
    eth_sepolia:   fmt(curEth - prevEth, 6),
  };
}

async function updateSnapshots(balances) {
  const today = todayUTC();
  const snapshotsData = readJSON(SNAPSHOTS_FILE) || { snapshots: [] };

  const newEntry = {
    date: today,
    balances: {
      solana_devnet: balances.solana,
      base_sepolia:  balances.base,
      eth_sepolia:   balances.eth,
    },
    eth_price_usd: balances.ethPrice,
    tasks_completed: 0,
    tasks_active: 5,
    milestone: null,
  };

  // Remove any existing entry for today, then append fresh one
  snapshotsData.snapshots = snapshotsData.snapshots.filter(s => s.date !== today);
  snapshotsData.snapshots.push(newEntry);

  // Keep last 90 days
  snapshotsData.snapshots = snapshotsData.snapshots
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-90);

  writeJSON(SNAPSHOTS_FILE, snapshotsData);
  log(`Snapshots updated (${snapshotsData.snapshots.length} entries)`);
  return snapshotsData.snapshots;
}

async function updateLatest(balances, snapshots) {
  const today = todayUTC();

  // Find yesterday's snapshot for delta calculation
  const yesterday = snapshots.filter(s => s.date < today).pop();
  const currentBals = {
    solana_devnet: balances.solana,
    base_sepolia:  balances.base,
    eth_sepolia:   balances.eth,
  };
  const dailyChange = calcDailyChange(yesterday?.balances, currentBals);

  // Calculate streak (consecutive days with a snapshot)
  let streak = 1;
  const sortedDates = snapshots.map(s => s.date).sort().reverse();
  for (let i = 1; i < sortedDates.length; i++) {
    const prev = new Date(sortedDates[i - 1]);
    const curr = new Date(sortedDates[i]);
    const diffDays = Math.round((prev - curr) / 86400000);
    if (diffDays === 1) streak++;
    else break;
  }

  const latest = {
    last_updated: new Date().toISOString(),
    balances: currentBals,
    daily_change: dailyChange,
    streak_days: streak,
    total_tasks_completed: 0,
  };

  writeJSON(LATEST_FILE, latest);
  log(`latest.json updated — streak: ${streak} days`);
}

async function updateActivityLog(balances) {
  const today = todayUTC();
  const logData = readJSON(ACTIVITY_FILE) || { entries: [] };

  // Avoid duplicate daily entries
  const alreadyLogged = logData.entries.some(
    e => e.date === today && e.type === 'daily-snapshot'
  );

  if (!alreadyLogged) {
    logData.entries.push({
      date: today,
      type: 'daily-snapshot',
      message: `Daily snapshot recorded — SOL: ${balances.solana} | Base: ${balances.base} | ETH: ${balances.eth} 📊`,
      emoji: '📊',
    });
    // Keep last 60 entries
    logData.entries = logData.entries.slice(-60);
    writeJSON(ACTIVITY_FILE, logData);
    log('Activity log updated');
  } else {
    log('Activity log: entry for today already exists, skipping');
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log('=== Daily Dashboard Update Starting ===');

  const balances = await fetchBalances();
  const snapshots = await updateSnapshots(balances);
  await updateLatest(balances, snapshots);
  await updateActivityLog(balances);

  log('=== Daily Dashboard Update Complete ===');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
