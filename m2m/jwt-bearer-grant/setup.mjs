// JWT Bearer グラント (RFC 7523) の事前準備
//  1. 呼び出し側サービスの鍵ペアを生成
//  2. Hydra に OAuth2 クライアントを登録
//  3. Hydra に「この iss / sub の JWT をこの公開鍵で信頼する」という信頼関係を登録
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";

const ADMIN = "http://localhost:4445";
const ISSUER = "https://my-service.example.com"; // assertion の iss
const SUBJECT = "my-service"; // assertion の sub (アクセストークンの sub になる)
const SCOPES = ["read", "write"];

const dir = new URL(".", import.meta.url).pathname;

async function admin(path, body) {
  const res = await fetch(ADMIN + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path} ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

// 1. 鍵ペア (秘密鍵はサービス側だけが持つ。Hydra には公開鍵だけ渡す)
const kid = `my-service-${Date.now()}`;
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" };
writeFileSync(dir + "private.pem", privateKey.export({ type: "pkcs8", format: "pem" }));

// 2. クライアント
const client = await admin("/admin/clients", {
  client_name: "m2m-jwt-bearer-demo",
  grant_types: ["urn:ietf:params:oauth:grant-type:jwt-bearer"],
  token_endpoint_auth_method: "client_secret_basic",
  scope: SCOPES.join(" "),
});

// 3. 信頼関係
const trust = await admin("/admin/trust/grants/jwt-bearer/issuers", {
  issuer: ISSUER,
  subject: SUBJECT,
  scope: SCOPES,
  jwk,
  expires_at: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
});

writeFileSync(
  dir + "config.json",
  JSON.stringify(
    { client_id: client.client_id, client_secret: client.client_secret, issuer: ISSUER, subject: SUBJECT, kid },
    null,
    2,
  ),
);

console.log("client_id :", client.client_id);
console.log("trust id  :", trust.id);
console.log("kid       :", kid);
console.log("-> m2m/private.pem, m2m/config.json を保存しました");
