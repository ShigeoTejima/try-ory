// private_key_jwt で API-A 宛てのアクセストークンを取得し、リソースサーバーを呼ぶ
// 事前に m2m/resource-server/server.mjs を API-A (8081) と API-B (8082) で起動しておく
import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { readFileSync } from "node:fs";

const TOKEN_URL = "http://localhost:4444/oauth2/token";
const API_A = { audience: "https://api-a.example.com", url: "http://localhost:8081" };
const API_B = { audience: "https://api-b.example.com", url: "http://localhost:8082" };

const dir = new URL(".", import.meta.url).pathname;
const cfg = JSON.parse(readFileSync(dir + "config.json", "utf8"));
const privateKey = createPrivateKey(readFileSync(dir + "private.pem"));

const b64url = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

// client_assertion を作って client_credentials でトークンを取得する
async function getToken({ scope, audience }) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT", kid: cfg.kid };
  const payload = { iss: cfg.client_id, sub: cfg.client_id, aud: TOKEN_URL, iat: now, exp: now + 300, jti: randomUUID() };
  const signingInput = `${b64url(header)}.${b64url(payload)}`;
  const clientAssertion = `${signingInput}.${sign("sha256", Buffer.from(signingInput), privateKey).toString("base64url")}`;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: clientAssertion,
      scope,
      audience,
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`token ${res.status}: ${JSON.stringify(json)}`);
  return json.access_token;
}

async function call(label, method, url, accessToken, body) {
  const res = await fetch(url, {
    method,
    headers: {
      ...(accessToken && { Authorization: `Bearer ${accessToken}` }),
      ...(body && { "Content-Type": "application/json" }),
    },
    body: body && JSON.stringify(body),
  });
  const wwwAuth = res.headers.get("www-authenticate");
  console.log(`${label.padEnd(36)} ${res.status}`, await res.json(), wwwAuth ? `\n${"".padEnd(40)}WWW-Authenticate: ${wwwAuth}` : "");
}

// API-A 宛て・read のみのトークン
const token = await getToken({ scope: "read", audience: API_A.audience });
console.log("access_token (aud=API-A, scope=read):", token.slice(0, 24) + "...\n");

await call("API-A GET  /items (read)", "GET", `${API_A.url}/items`, token);
await call("API-A POST /items (write が無い)", "POST", `${API_A.url}/items`, token, { name: "new" });
await call("API-B GET  /items (aud が違う)", "GET", `${API_B.url}/items`, token);
await call("API-A GET  /items (トークン無し)", "GET", `${API_A.url}/items`);
await call("API-A GET  /items (でたらめなトークン)", "GET", `${API_A.url}/items`, "ory_at_invalid.token");

// read write 両方のトークンなら書き込める
const rwToken = await getToken({ scope: "read write", audience: API_A.audience });
await call("API-A POST /items (read write)", "POST", `${API_A.url}/items`, rwToken, { name: "new" });
