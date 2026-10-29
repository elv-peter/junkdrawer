#!/usr/bin/env node
// Parse a Chrome DevTools "Copy as fetch" string for a Content Fabric request and
// print shell `export` lines for AUTH_TOKEN, AUTH_HEADER, QHOST, QID, QHASH, QLIB.
// For live streams, also fetches the object's live_recording/fabric_config metadata
// to set EDGE_HOST and WRITE_TOKEN.
//
// Usage:
//   eval "$(node fetch-to-env.js)"            # reads the clipboard (pbpaste)
//   eval "$(node fetch-to-env.js file.txt)"   # reads a file
//   pbpaste | node fetch-to-env.js -          # reads stdin

const fs = require("fs");
const { execSync } = require("child_process");

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function fromB58(str) {
  let n = 0n;
  for(const c of str) {
    const i = B58_ALPHABET.indexOf(c);
    if(i < 0) throw new Error(`Invalid base58 character "${c}"`);
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  while(n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for(const c of str) {
    if(c !== "1") break;
    bytes.unshift(0);
  }
  return bytes;
}

function toB58(bytes) {
  let n = 0n;
  for(const b of bytes) n = n * 256n + BigInt(b);
  let str = "";
  while(n > 0n) {
    str = B58_ALPHABET[Number(n % 58n)] + str;
    n /= 58n;
  }
  for(const b of bytes) {
    if(b !== 0) break;
    str = "1" + str;
  }
  return str;
}

// Version hash payload: 32-byte digest, varint size, then the object ID bytes
// (same layout as Utils.DecodeVersionHash in elv-client-js)
function hashToObjectId(hash) {
  let bytes = fromB58(hash.slice(4)).slice(32);
  let sizeLength = 0;
  while(bytes[sizeLength] >= 128) sizeLength++;
  bytes = bytes.slice(sizeLength + 1);
  return "iq__" + toB58(bytes);
}

function readInput() {
  const arg = process.argv[2];
  if(arg === "-") return fs.readFileSync(0, "utf8");
  if(arg) return fs.readFileSync(arg, "utf8");
  return execSync("pbpaste", { encoding: "utf8" });
}

// Single-quote a value so it is safe to eval in bash/zsh
function shQuote(value) {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function parse(input) {
  const urlMatch = input.match(/fetch\(\s*"([^"]+)"/);
  if(!urlMatch) throw new Error("No fetch(\"...\") URL found in input");
  const url = new URL(urlMatch[1]);

  const authMatch = input.match(/"authorization"\s*:\s*"Bearer ([^"]+)"/i);
  const token = authMatch ? authMatch[1] : url.searchParams.get("authorization");

  // QHOST is everything before /qlibs/ or /q/, e.g. https://host or http://localhost:8008/s/demov3
  const pathMatch = url.pathname.match(/^(.*?)\/(?:qlibs\/(ilib\w+)\/)?q\/((?:hq|iq|tq)__\w+)/);
  if(!pathMatch) throw new Error(`No /q/<id or hash> found in URL path: ${url.pathname}`);
  const [, prefix, lib, idOrHash] = pathMatch;

  const vars = { QHOST: url.origin + prefix };
  if(idOrHash.startsWith("iq__")) {
    vars.QID = idOrHash;
  } else {
    vars.QHASH = idOrHash;
    vars.QID = hashToObjectId(idOrHash);
  }
  if(lib) vars.QLIB = lib;
  if(token) vars.AUTH_TOKEN = token;

  return vars;
}

// Same lookup as elv-client-js LiveStream status: ingress_node_api may be a bare hostname
async function fetchLiveConfig(vars) {
  const url = `${vars.QHOST}/q/${vars.QID}/meta/live_recording/fabric_config`;
  const headers = vars.AUTH_TOKEN ? { Authorization: `Bearer ${vars.AUTH_TOKEN}` } : {};
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
  if(!res.ok) throw new Error(`${res.status} ${res.statusText} from ${url}`);

  const config = await res.json();
  const live = {};
  let edgeHost = config.ingress_node_api;
  if(edgeHost) {
    if(!edgeHost.startsWith("http")) edgeHost = "https://" + edgeHost;
    live.EDGE_HOST = edgeHost.replace(/\/+$/, "");
  }
  if(config.edge_write_token) live.WRITE_TOKEN = config.edge_write_token;
  return live;
}

(async () => {
  try {
    const vars = parse(readInput());

    try {
      Object.assign(vars, await fetchLiveConfig(vars));
    } catch(e) {
      console.error(`warning: could not read live config: ${e.message}`);
    }

    for(const [k, v] of Object.entries(vars)) {
      console.log(`export ${k}=${shQuote(v)}`);
    }
    // Clear values left over from a previous stream
    const missing = ["EDGE_HOST", "WRITE_TOKEN"].filter(k => !vars[k]);
    if(missing.length) console.log(`unset ${missing.join(" ")}`);

    if(vars.AUTH_TOKEN) {
      console.log("export AUTH_HEADER=\"Authorization: Bearer $AUTH_TOKEN\"");
    } else {
      console.error("warning: no authorization token found");
    }
    // Summary on stderr so it shows up without being eval'd
    for(const [k, v] of Object.entries(vars)) {
      console.error(`${k}=${k === "AUTH_TOKEN" ? v.slice(0, 12) + "..." : v}`);
    }
  } catch(e) {
    console.error(`error: ${e.message}`);
    // Make `eval` fail visibly instead of silently doing nothing
    console.log("false");
    process.exit(1);
  }
})();
