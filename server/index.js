#!/usr/bin/env node
// In-process MCP proxy: stdio (Claude Desktop) <-> Streamable HTTP (netmon /mcp).
// No child spawn, no NODE_EXTRA_CA_CERTS, no mcp-remote bin. The wrapper IS
// the MCP server; it forwards every JSON-RPC message to the remote endpoint
// and forwards every response back.
//
// TLS is trust-on-first-use, SSH-style: the first connection captures the
// server's leaf certificate, and every later handshake must present that
// exact certificate — sha-256 fingerprint equality enforced by a custom
// undici connector. Fingerprint equality is the WHOLE check: no CA chain,
// no hostname/SAN rules, no validity window. Fleet appliances serve
// self-signed certs that may predate SAN-aware generation or drift from the
// client clock, and Node's WebPKI rules reject those even when the cert is
// explicitly trusted. Appliances also regenerate certs in normal operation,
// so a changed certificate is detected by a probe at every startup, logged
// with both fingerprints, and re-pinned rather than refused — the pin gives
// verification continuity between rotations, not hard MITM refusal.
//
// The pinned fetch is passed to the SDK transport explicitly (never via
// setGlobalDispatcher alone): the global-dispatcher symbol is shared state
// between the bundled undici and the host runtime's built-in fetch, and
// whether it applies depends on the runtime pairing. Explicit plumbing is
// deterministic everywhere, including Claude Desktop's Electron-as-Node.

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

const STATE_DIR = path.join(os.homedir(), '.netmon-mcp');
const LOG_PATH = path.join(STATE_DIR, 'wrapper.log');
const PROBE_TIMEOUT_MS = 10000;

let VERSION = 'unknown';
try {
  VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
} catch (_) {}

function diag(msg) {
  const line = `[${new Date().toISOString()}] [pid ${process.pid}] ${msg}\n`;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    fs.appendFileSync(LOG_PATH, line);
  } catch (_) {}
  try { process.stderr.write(`[netmon-mcp] ${msg}\n`); } catch (_) {}
}

// "fetch failed" alone is undiagnosable — walk the cause chain so the log
// carries the real error (TLS code, DNS failure, connection refusal, ...).
function errChain(err) {
  const parts = [];
  for (let e = err, depth = 0; e && depth < 6; e = e.cause, depth += 1) {
    const msg = e.message || String(e);
    parts.push(e.code && !msg.includes(e.code) ? `${msg} [${e.code}]` : msg);
  }
  return parts.join(' <- ');
}

function tlsHint(err) {
  for (let e = err; e; e = e.cause) {
    if (/CERT|TLS|SSL|pinned/i.test(`${e.code || ''} ${e.message || ''}`)) {
      return ' (server certificate may have changed since startup — restart the extension to re-pin)';
    }
  }
  return '';
}

process.on('uncaughtException', (err) => {
  diag(`uncaughtException: ${err && err.stack ? err.stack : err}`);
  process.exit(3);
});
process.on('unhandledRejection', (err) => {
  diag(`unhandledRejection: ${err && err.stack ? err.stack : err}`);
  process.exit(3);
});

diag(`wrapper ${VERSION} starting (node ${process.version}, execPath ${process.execPath}).`);

const url = (process.env.NETMON_URL || '').trim();
const rawToken = (process.env.NETMON_TOKEN || '').trim();

if (!url) {
  diag('NETMON_URL is required (set it in the extension settings).');
  process.exit(2);
}
if (!rawToken) {
  diag('NETMON_TOKEN is required (set it in the extension settings).');
  process.exit(2);
}

const authHeader = /^Bearer\s+/i.test(rawToken) ? rawToken : `Bearer ${rawToken}`;

let parsed;
try {
  parsed = new URL(url);
} catch {
  diag(`NETMON_URL is not a valid URL: ${url}`);
  process.exit(2);
}
if (parsed.protocol !== 'https:') {
  diag(`NETMON_URL must use https:// (got ${parsed.protocol}).`);
  process.exit(2);
}

const urlHash = crypto.createHash('sha256').update(url).digest('hex');
const pinPath = path.join(STATE_DIR, `${urlHash}.pem`);

function probeServedCert() {
  return new Promise((resolve, reject) => {
    const port = parsed.port ? Number(parsed.port) : 443;
    const opts = { host: parsed.hostname, port, rejectUnauthorized: false };
    if (net.isIP(parsed.hostname) === 0) opts.servername = parsed.hostname;
    const socket = tls.connect(opts, () => {
      try {
        const peer = socket.getPeerCertificate(false);
        socket.end();
        if (!peer || !peer.raw) {
          reject(new Error('TLS probe returned no certificate.'));
          return;
        }
        resolve(new crypto.X509Certificate(peer.raw));
      } catch (err) {
        socket.destroy();
        reject(err);
      }
    });
    socket.setTimeout(PROBE_TIMEOUT_MS, () => {
      socket.destroy(new Error(`TLS probe timed out after ${PROBE_TIMEOUT_MS}ms.`));
    });
    socket.on('error', reject);
  });
}

function savePin(x509) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${pinPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, x509.toString(), { mode: 0o600 });
  fs.renameSync(tmp, pinPath);
}

// Load the stored pin and reconcile it against what the server serves right
// now. A rotated appliance cert is re-pinned here so a regeneration never
// strands the extension behind a stale pin; an unreachable server falls back
// to the stored pin so a transient outage doesn't block startup.
async function resolvePin() {
  let pinned = null;
  if (fs.existsSync(pinPath)) {
    try {
      pinned = new crypto.X509Certificate(fs.readFileSync(pinPath));
    } catch (err) {
      diag(`pin file at ${pinPath} is unreadable (${err.message}) — discarding and re-capturing.`);
    }
  }

  let served;
  try {
    served = await probeServedCert();
  } catch (err) {
    if (pinned) {
      diag(`startup probe of ${parsed.hostname} failed (${errChain(err)}) — continuing with the stored pin.`);
      return pinned;
    }
    throw err;
  }

  if (!pinned) {
    savePin(served);
    diag(`First connection to ${parsed.hostname} — pinned server certificate ${served.fingerprint256} (valid ${served.validFrom} -> ${served.validTo}) at ${pinPath}.`);
    return served;
  }

  if (pinned.fingerprint256 !== served.fingerprint256) {
    diag(`SERVER CERTIFICATE CHANGED for ${parsed.hostname}: pinned ${pinned.fingerprint256}, now serving ${served.fingerprint256} (valid ${served.validFrom} -> ${served.validTo}).`);
    diag('Re-pinning to the new certificate (appliance certs are regenerated in normal operation). If you did not expect this change, investigate before trusting this connection.');
    savePin(served);
    return served;
  }

  diag(`Using pinned certificate ${pinned.fingerprint256} at ${pinPath}.`);
  return pinned;
}

async function main() {
  let pin;
  try {
    pin = await resolvePin();
  } catch (err) {
    diag(`TLS probe failed: ${errChain(err)}`);
    diag(`Could not capture cert from ${parsed.hostname}:${parsed.port || 443}. Check that NETMON_URL is reachable.`);
    process.exit(2);
  }
  const pinnedFp = pin.fingerprint256;

  const { Agent, fetch: undiciFetch, setGlobalDispatcher, buildConnector } = await import('undici');

  // TLS handshakes accept anything; identity is decided by fingerprint
  // equality against the pin, checked on the live socket before any bytes of
  // the request are written.
  const insecureConnect = buildConnector({ rejectUnauthorized: false });
  const pinnedConnect = (opts, cb) => {
    insecureConnect(opts, (err, socket) => {
      if (err) {
        cb(err, null);
        return;
      }
      if (socket instanceof tls.TLSSocket) {
        let fp = null;
        try {
          const peer = socket.getPeerCertificate(false);
          if (peer && peer.raw) fp = new crypto.X509Certificate(peer.raw).fingerprint256;
        } catch (_) {}
        if (fp !== pinnedFp) {
          socket.destroy();
          cb(new Error(`server certificate ${fp || '(none)'} does not match pinned ${pinnedFp}`), null);
          return;
        }
      }
      cb(null, socket);
    });
  };

  const dispatcher = new Agent({ connect: pinnedConnect });
  setGlobalDispatcher(dispatcher);
  const pinnedFetch = (input, init) => undiciFetch(input, { ...(init || {}), dispatcher });
  diag(`pinned fetch configured; peers must present certificate ${pinnedFp}.`);

  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

  const stdioTransport = new StdioServerTransport();
  const httpTransport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: authHeader } },
    fetch: pinnedFetch,
  });

  stdioTransport.onmessage = (msg) => {
    httpTransport.send(msg).catch((err) => {
      const detail = `${errChain(err)}${tlsHint(err)}`;
      diag(`http send error: ${detail}`);
      // Answer requests with a JSON-RPC error so Claude Desktop surfaces the
      // cause instead of timing out on a response that will never come.
      if (msg && msg.method && msg.id !== undefined && msg.id !== null) {
        stdioTransport
          .send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: `netmon-mcp: ${detail}` } })
          .catch(() => {});
      }
    });
  };
  httpTransport.onmessage = (msg) => {
    stdioTransport.send(msg).catch((err) => diag(`stdio send error: ${errChain(err)}`));
  };

  let closing = false;
  const closeBoth = (reason) => {
    if (closing) return;
    closing = true;
    diag(`closing both transports (${reason}).`);
    Promise.allSettled([stdioTransport.close(), httpTransport.close()]).finally(() => process.exit(0));
  };
  stdioTransport.onclose = () => closeBoth('stdio closed');
  httpTransport.onclose = () => closeBoth('http closed');
  stdioTransport.onerror = (err) => diag(`stdio error: ${errChain(err)}`);
  httpTransport.onerror = (err) => diag(`http error: ${errChain(err)}${tlsHint(err)}`);

  await httpTransport.start();
  diag(`http transport connected to ${url}.`);
  await stdioTransport.start();
  diag('stdio transport ready, proxy active.');
}

main().catch((err) => {
  diag(`fatal: ${err && err.stack ? err.stack : err}`);
  process.exit(2);
});
