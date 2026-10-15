// private_key_jwt でクライアント認証し、client_credentials でアクセストークンを取得する
// 取得したトークンを、リソースサーバー (API-A / API-B) の立場で introspect して検証する
import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { readFileSync } from "node:fs";

const PUBLIC = "http://localhost:4444";
const ADMIN = "http://localhost:4445";
const TOKEN_URL = `${PUBLIC}/oauth2/token`;

const API_A = "https://api-a.example.com";
const API_B = "https://api-b.example.com";

const dir = new URL(".", import.meta.url).pathname;
const cfg = JSON.parse(readFileSync(dir + "config.json", "utf8"));
const privateKey = createPrivateKey(readFileSync(dir + "private.pem"));

const b64url = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

// 1. client_assertion (クライアントが自分の秘密鍵で署名した JWT)
const now = Math.floor(Date.now() / 1000);
const header = { alg: "RS256", typ: "JWT", kid: cfg.kid };
const payload = {
  iss: cfg.client_id, // iss と sub はどちらも client_id
  sub: cfg.client_id,
  aud: TOKEN_URL, // トークンエンドポイントの URL (アクセストークンの aud とは別物)
  iat: now,
  exp: now + 300,
  jti: randomUUID(), // 使い回し防止
};
const signingInput = `${b64url(header)}.${b64url(payload)}`;
const clientAssertion = `${signingInput}.${sign("sha256", Buffer.from(signingInput), privateKey).toString("base64url")}`;
console.log("client_assertion payload:", payload, "\n");

// 2. client_credentials でトークン要求 (Authorization ヘッダも client_secret も無し)
const requestToken = () =>
  fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: clientAssertion,
      scope: "read",
      audience: API_A, // API-A 宛てのトークンを要求 (クライアントの許可リストに無い宛先は拒否される)
    }),
  });

const res = await requestToken();
const token = await res.json();
console.log("token response:", res.status, token, "\n");
if (!res.ok) process.exit(1);

// 3. リソースサーバー側の検証 (introspect)
//    introspect は無効なトークンでも HTTP 200 + { active: false } を返すので、本文で判定する
async function verify(accessToken, { audience, requiredScope }) {
  const res = await fetch(`${ADMIN}/admin/oauth2/introspect`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: accessToken }),
  });
  const info = await res.json();
  if (!info.active) return { ok: false, status: 401, reason: "無効・期限切れ" };
  if (info.token_use !== "access_token") return { ok: false, status: 401, reason: "アクセストークンではない" };
  if (!info.aud?.includes(audience)) return { ok: false, status: 401, reason: `自分 (${audience}) 宛てではない: aud=${JSON.stringify(info.aud)}` };
  if (!info.scope?.split(" ").includes(requiredScope)) return { ok: false, status: 403, reason: `スコープ ${requiredScope} が無い` };
  return { ok: true, client_id: info.client_id, sub: info.sub, aud: info.aud, scope: info.scope };
}

console.log("API-A (read) :", await verify(token.access_token, { audience: API_A, requiredScope: "read" }));
console.log("API-A (write):", await verify(token.access_token, { audience: API_A, requiredScope: "write" }));
console.log("API-B (read) :", await verify(token.access_token, { audience: API_B, requiredScope: "read" }), "\n");

// 4. 同じ client_assertion (同じ jti) の再利用は拒否されるはず
const replay = await requestToken();
console.log("replay same assertion:", replay.status, await replay.json());
