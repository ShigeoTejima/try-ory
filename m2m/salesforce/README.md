# Salesforce の指定ログイン情報から Hydra のトークンでリソースサーバーを呼ぶ

Salesforce の外部ログイン情報 (External Credential) の **「JWT アサーションを使うクライアントログイン情報」(Client Credentials with JWT Assertion)** フローで Hydra からアクセストークンを取得し、指定ログイン情報 (Named Credential) 経由でリソースサーバーを呼ぶ検証。

```
Apex: callout:hydra_api_a/items
  │
  ├─(1) 外部ログイン情報: 証明書で署名した client_assertion で client_credentials 要求
  │       → https://<hydra-url>/oauth2/token   (ngrok → Hydra Public API :4444)
  │
  └─(2) 指定ログイン情報: Authorization: Bearer <access_token> を付けて送信
          → https://<api-url>/items            (ngrok → リソースサーバー :8081)
                └─ Hydra Admin API (:4445, 非公開) の introspect で検証
```

- クライアント認証は private_key_jwt 相当。Salesforce の「証明書と鍵」の秘密鍵で署名し、Hydra には公開鍵だけを登録する
- Salesforce は `audience` パラメータを送れないため、宛先は **スコープ** (`api-a.read` など) で表す (後述)

## 前提

- ngrok (authtoken 設定済み)、sf CLI (対象組織で認証済み)
- `docker compose up -d` で Hydra が起動していること

## 手順

### 1. ngrok でトークン URL とリソースサーバー URL を公開

```sh
ngrok start --all --config "$HOME/Library/Application Support/ngrok/ngrok.yml" --config ngrok.yml
```

[ngrok.yml](../../ngrok.yml) で2本のトンネルを張る (`hydra` → 4444、`api` → 8081)。Admin API (4445) は公開しない。
公開 URL は http://localhost:4040 または `curl -s localhost:4040/api/tunnels | jq '.tunnels[] | {name, public_url}'` で確認する。無料プランでは起動のたびに URL が変わる。

以下、`hydra` の URL を `<hydra-url>`、`api` の URL を `<api-url>` と書く。

### 2. Hydra の issuer を公開 URL にする

```sh
HYDRA_PUBLIC_URL=<hydra-url> docker compose up -d hydra
curl -s <hydra-url>/.well-known/openid-configuration | jq '{issuer, token_endpoint}'
```

client_assertion の `aud` (トークン URL) の検証に issuer が使われるため、Salesforce から見える URL に合わせる。

### 3. リソースサーバーをスコープ方式で起動

```sh
SCOPE_PREFIX=api-a. PORT=8081 node m2m/resource-server/server.mjs
```

`SCOPE_PREFIX` を指定すると、`aud` を見ずに `api-a.read` / `api-a.write` のスコープで宛先と権限を判断する。

### 4. Salesforce で証明書を作成

設定 → 証明書と鍵の管理 → **自己署名証明書を作成** (例: API 参照名 `ory`)

### 5. 証明書の公開鍵で Hydra にクライアントを登録

```sh
sf project retrieve start --metadata Certificate:ory --target-org <your-org> --target-metadata-dir <dir> --unzip
node m2m/salesforce/register-client.mjs <dir>/unpackaged/unpackaged/certs/ory.crt
```

取得できるのは公開証明書だけ (秘密鍵は含まれない)。[register-client.mjs](register-client.mjs) が JWK に変換し、`private_key_jwt` のクライアントとして登録する。出力される `client_id` を次の手順で使う。

### 6. Salesforce で外部ログイン情報・指定ログイン情報・権限セットを設定

**外部ログイン情報** (例: 名前 `hydra`)

| 項目 | 値 |
|---|---|
| 認証プロトコル | OAuth 2.0 |
| 認証フロー種別 | JWT アサーションを使うクライアントログイン情報 |
| ID プロバイダーの URL | `<hydra-url>/oauth2/token` |
| 範囲 (Scope) | `api-a.read` |
| 署名証明書 | `ory` |
| JWT の発行者 (iss) / 件名 (sub) | `<client_id>` |
| JWT の対象者 (aud) | `<hydra-url>/oauth2/token` |
| カスタムクレーム `jti` | `{!TEXT(FLOOR((NOW() - DATETIMEVALUE("1970-01-01 00:00:00")) * 86400000))}` |

あわせてプリンシパルを1つ作成する。

**指定ログイン情報** (例: 名前 `hydra_api_a`)

| 項目 | 値 |
|---|---|
| URL | `<api-url>` |
| 外部ログイン情報 | `hydra` |
| 認証ヘッダーを生成 | オン |

**権限セット**: 外部ログイン情報プリンシパルアクセスで、上のプリンシパルを有効にして自分に割り当てる。

### 7. 匿名 Apex で呼ぶ

```sh
sf apex run --target-org <your-org> --file m2m/salesforce/apex/get-items.apex
sf apex run --target-org <your-org> --file m2m/salesforce/apex/post-items.apex
```

Salesforce が実際に送ったリクエスト (client_assertion の中身など) は ngrok の http://localhost:4040 で確認できる。

## 結果

| リクエスト | トークンのスコープ | 結果 |
|---|---|---|
| `GET /items` | `api-a.read` | 200 |
| `POST /items` | `api-a.read` | 403 `insufficient_scope` (`api-a.write` が必要) |

Salesforce が送ったトークン要求:

```
grant_type            = client_credentials
client_assertion_type = urn:ietf:params:oauth:client-assertion-type:jwt-bearer
client_id             = <client_id>
scope                 = api-a.read
client_assertion      = (JWT)
  header  {"kid":"ory","typ":"JWT","alg":"RS256"}
  payload {"iss":"<client_id>","sub":"<client_id>","aud":"<hydra-url>/oauth2/token",
           "iat":..., "nbf":..., "exp":...(iat+300), "jti":"1792101888435"}
```

## ハマりどころ

| 項目 | 内容・対処 |
|---|---|
| JWT ヘッダーの `kid` | 証明書の API 参照名 (`ory`) が入る。Hydra のクライアントの jwks も同じ `kid` で登録する |
| `jti` が無い | 標準では入らず、Hydra に `Claim 'jti' from 'client_assertion' must be set` で拒否される。カスタムクレームで追加する |
| `jti` が数式にならない | 値を `{!...}` で囲まないと文字列のまま送られる (同じ値が再利用され、次回のトークン取得で `jti_known` になる) |
| `jti` の数式で使えない関数 | `UNIXTIMESTAMP` は「この種類の数式では使用できません」。標準の `exp` と同じく `NOW() - DATETIMEVALUE("1970-01-01 00:00:00")` で UNIX 時刻を作る (ミリ秒にして重複を避ける) |
| `audience` を送れない | トークン要求に任意のパラメータを足す手段が無い。カスタムヘッダーはリソースサーバーへのリクエストに付くだけで、トークン要求には付かない → トークンの `aud` が空になる。宛先はスコープ (`api-a.read`) で表す |
| トークンが更新されない | 取得したトークンを `expires_in` が切れるまで使い回し、401 を受けても取り直さない (「期限切れのログイン情報を更新できませんでした」)。スコープなどの設定を変えても即時には反映されない |
| 保持中のトークンを破棄したい | プリンシパルを削除して作り直す。**権限セットのプリンシパルアクセスも設定し直す** (しないと「ログイン情報にアクセスできません」) |

## 片付け

- ngrok を止める (公開した Hydra は `--dev` モード・仮の secret のまま。検証後は公開し続けない)
- Hydra の issuer を戻す: `docker compose up -d hydra` (`HYDRA_PUBLIC_URL` を指定しなければ `http://localhost:4444`)
