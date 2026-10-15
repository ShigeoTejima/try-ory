// JWT Bearer グラントでアクセストークンを取得し、introspect で中身を確認する
import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { readFileSync } from "node:fs";

const PUBLIC = "http://localhost:4444";
const ADMIN = "http://localhost:4445";
const TOKEN_URL = `${PUBLIC}/oauth2/token`;

const dir = new URL(".", import.meta.url).pathname;
const cfg = JSON.parse(readFileSync(dir + "config.json", "utf8"));
const privateKey = createPrivateKey(readFileSync(dir + "private.pem"));

const b64url = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

// 1. assertion (サービスが自分の秘密鍵で署名した JWT)
const now = Math.floor(Date.now() / 1000);
const header = { alg: "RS256", typ: "JWT", kid: cfg.kid };
const payload = {
  iss: cfg.issuer,
  sub: cfg.subject,
  aud: TOKEN_URL, // トークンエンドポイントの URL でなければならない
  iat: now,
  exp: now + 300,
  jti: randomUUID(), // 使い回し防止 (Hydra はデフォルトで必須)
};
const signingInput = `${b64url(header)}.${b64url(payload)}`;
const assertion = `${signingInput}.${sign("sha256", Buffer.from(signingInput), privateKey).toString("base64url")}`;
console.log("assertion payload:", payload, "\n");

// 2. assertion をアクセストークンと交換
const res = await fetch(TOKEN_URL, {
  method: "POST",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
    Authorization: "Basic " + Buffer.from(`${encodeURIComponent(cfg.client_id)}:${encodeURIComponent(cfg.client_secret)}`).toString("base64"),
  },
  body: new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
    scope: "read",
  }),
});
const token = await res.json();
console.log("token response:", res.status, token, "\n");
if (!res.ok) process.exit(1);

// 3. リソースサーバー側の検証イメージ (introspect)
const intro = await fetch(`${ADMIN}/admin/oauth2/introspect`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ token: token.access_token }),
});
console.log("introspect:", await intro.json());
