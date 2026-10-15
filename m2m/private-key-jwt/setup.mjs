// private_key_jwt (RFC 7523 §2.2) の事前準備
//  1. クライアントの鍵ペアを生成
//  2. 公開鍵 (jwks) を持たせて OAuth2 クライアントを登録
//     (Hydra は client_secret も生成して返すが、auth method が private_key_jwt なので secret では認証できない)
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";

const ADMIN = "http://localhost:4445";

const dir = new URL(".", import.meta.url).pathname;

// 1. 鍵ペア (秘密鍵はクライアントだけが持つ。Hydra には公開鍵だけ渡す)
const kid = `m2m-client-${Date.now()}`;
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" };
writeFileSync(dir + "private.pem", privateKey.export({ type: "pkcs8", format: "pem" }));

// 2. クライアント
const res = await fetch(ADMIN + "/admin/clients", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    client_name: "m2m-private-key-jwt-demo",
    grant_types: ["client_credentials"],
    token_endpoint_auth_method: "private_key_jwt",
    token_endpoint_auth_signing_alg: "RS256",
    jwks: { keys: [jwk] }, // 本番では jwks_uri で公開して鍵ローテーションしやすくするのが一般的
    scope: "read write",
    // このクライアントがトークン要求時に指定してよい宛先 (リソースサーバー) の許可リスト。
    // ここに登録するだけではトークンの aud には入らない。要求時に audience パラメータで指定する
    audience: ["https://api-a.example.com", "https://api-b.example.com"],
  }),
});
const client = await res.json();
if (!res.ok) throw new Error(`/admin/clients ${res.status}: ${JSON.stringify(client)}`);

writeFileSync(dir + "config.json", JSON.stringify({ client_id: client.client_id, kid }, null, 2));

console.log("client_id                 :", client.client_id);
console.log("token_endpoint_auth_method:", client.token_endpoint_auth_method);
console.log("audience (許可リスト)      :", client.audience);
console.log("-> private.pem, config.json を保存しました");
