// Salesforce の「証明書と鍵」の公開証明書から、private_key_jwt の Hydra クライアントを登録する
//
//   sf project retrieve start --metadata Certificate:ory --target-org <your-org> --target-metadata-dir <dir> --unzip
//   node m2m/salesforce/register-client.mjs <dir>/unpackaged/unpackaged/certs/ory.crt [kid]
//
// kid は Salesforce が client_assertion の JWT ヘッダーに入れる値に合わせる (デフォルト: 証明書のファイル名)
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const ADMIN = "http://localhost:4445";

const [certPath, kidArg] = process.argv.slice(2);
if (!certPath) throw new Error("usage: node register-client.mjs <cert.crt> [kid]");

const cert = new X509Certificate(readFileSync(certPath));
const kid = kidArg ?? basename(certPath, ".crt");
const jwk = { ...cert.publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" };

const res = await fetch(ADMIN + "/admin/clients", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    client_name: "salesforce-named-credential",
    owner: "salesforce",
    metadata: { description: "Salesforce の外部ログイン情報 (JWT アサーションを使うクライアントログイン情報) から利用", cert_subject: cert.subject },
    grant_types: ["client_credentials"],
    token_endpoint_auth_method: "private_key_jwt",
    token_endpoint_auth_signing_alg: "RS256",
    jwks: { keys: [jwk] },
    // Salesforce は audience パラメータを送れないので、宛先はスコープ (<API>.<権限>) で表す
    scope: "api-a.read api-a.write api-b.read api-b.write",
  }),
});
const client = await res.json();
if (!res.ok) throw new Error(`/admin/clients ${res.status}: ${JSON.stringify(client)}`);

console.log("client_id:", client.client_id);
console.log("kid      :", kid);
console.log("cert     :", cert.subject.replace(/\n/g, ", "), `(valid to ${cert.validTo})`);
