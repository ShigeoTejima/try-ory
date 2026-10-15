# Ory Hydra (docker compose)

> [!WARNING]
> **ローカル検証専用の構成です。本番では使わないでください。**
> - `config/hydra.yml` の secret (`youReallyNeedToChangeThis`) や `docker-compose.yml` の DB パスワード (`secret`) は仮の値
> - Hydra は `--dev` モード (HTTP で動作)、`log.leak_sensitive_values: true` でトークンがログに出る
> - Admin API (4445) をホストに公開している (Admin API には認証が無い)
> - ログイン/同意画面は固定ユーザー (foo@bar.com / foobar) のサンプルアプリ

| URL | 用途 |
|---|---|
| http://localhost:4444 | Public API (`/oauth2/auth`, `/oauth2/token`, `/.well-known/openid-configuration`) |
| http://localhost:4445 | Admin API (クライアント管理など。本番では外部公開しない) |
| http://localhost:3000 | サンプルのログイン/同意画面 (foo@bar.com / foobar) |

## 起動・停止

```sh
docker compose up -d
docker compose down        # データも消すなら -v
```

## client_credentials フロー

```sh
docker compose exec hydra hydra create client \
  --endpoint http://localhost:4445 \
  --grant-type client_credentials --format json
# 出力の client_id / client_secret を使う
docker compose exec hydra hydra perform client-credentials \
  --endpoint http://localhost:4444 --client-id <ID> --client-secret <SECRET>
```

## 認可コードフロー (ブラウザ)

```sh
docker compose exec hydra hydra create client \
  --endpoint http://localhost:4445 \
  --grant-type authorization_code,refresh_token \
  --response-type code,id_token \
  --scope openid,offline \
  --redirect-uri http://127.0.0.1:5555/callback --format json

docker compose exec hydra hydra perform authorization-code \
  --endpoint http://localhost:4444 --port 5555 \
  --client-id <ID> --client-secret <SECRET> --scope openid,offline
```

http://127.0.0.1:5555 を開く → ログイン (foo@bar.com / foobar) → 同意 → アクセストークン / IDトークン / リフレッシュトークンが表示される。

## トークンの検証 (introspect)

```sh
curl -s -X POST http://localhost:4445/admin/oauth2/introspect -d token=<ACCESS_TOKEN>
```

## M2M: client_credentials + private_key_jwt (RFC 7523 §2.2)

client_secret の代わりに、クライアントが自分の秘密鍵で署名した JWT (`client_assertion`) で認証する。Node 24 の標準機能だけで動く。

```sh
node m2m/private-key-jwt/setup.mjs      # 鍵ペア生成 + 公開鍵 (jwks) 付きでクライアント登録
node m2m/private-key-jwt/get-token.mjs  # client_assertion でトークン取得 → API-A / API-B の立場で検証 → 同じ jti の再利用が拒否されることを確認
```

### aud (複数のリソースサーバーがある場合)

- クライアント登録の `audience` は「要求してよい宛先の許可リスト」。登録するだけではトークンの `aud` には入らない
- トークン要求時に `audience` パラメータで宛先を指定すると、その値がトークンの `aud` に入る (許可リストに無い宛先は `invalid_request`)
- `audience` を指定しないと `aud: []` のトークンが発行されるので、リソースサーバーは「自分が `aud` に含まれているか」を必ず確認する

リソースサーバーの introspect 判定 (HTTP 200 でも無効なことがあるので本文で判定する):

| 確認項目 | NG のとき |
|---|---|
| `active === true` | 401 (無効・期限切れ・失効) |
| `token_use === "access_token"` | 401 (リフレッシュトークンを API に使わせない) |
| `aud` に自分が含まれる | 401 (別 API 宛てのトークンの流用を防ぐ) |
| `scope` に必要なスコープが含まれる | 403 |

- `client_assertion` の `iss` と `sub` はどちらも client_id、`aud` はトークンエンドポイントの URL (`http://localhost:4444/oauth2/token`)
- `jti` は必須かつ使い回し不可 (再利用すると `jti_known` エラー)
- Hydra はクライアント登録時に client_secret も返すが、`token_endpoint_auth_method: private_key_jwt` なので secret では認証できない

### リソースサーバーを呼ぶ

[m2m/resource-server/server.mjs](m2m/resource-server/server.mjs) は `Authorization: Bearer <token>` を introspect で検証する簡単な API。`AUDIENCE` (自分の識別子) と `PORT` を変えて API-A / API-B の2台を起動する。

| エンドポイント | 必要なスコープ |
|---|---|
| `GET /items` | `read` |
| `POST /items` | `write` |

```sh
# ターミナル1, 2
AUDIENCE=https://api-a.example.com PORT=8081 node m2m/resource-server/server.mjs
AUDIENCE=https://api-b.example.com PORT=8082 node m2m/resource-server/server.mjs

# ターミナル3 (事前に node m2m/private-key-jwt/setup.mjs)
node m2m/private-key-jwt/call-api.mjs
```

`call-api.mjs` は API-A 宛て (`audience=https://api-a.example.com`)・`scope=read` のトークンを取得して各パターンを呼ぶ。

| リクエスト | 結果 |
|---|---|
| API-A `GET /items` | 200 |
| API-A `POST /items` (write が無い) | 403 `insufficient_scope` |
| API-B `GET /items` (aud が API-A) | 401 `invalid_token` |
| API-A トークン無し | 401 |
| API-A でたらめなトークン | 401 `invalid_token` (`active: false`) |
| API-A `POST /items` (`scope=read write` で取り直し) | 201 |

- エラー時は RFC 6750 に沿って `WWW-Authenticate: Bearer error="..."` ヘッダを返す
- 401 = トークンが無効・自分宛てでない、403 = トークンは正しいが権限 (スコープ) 不足

## M2M: JWT Bearer グラント (RFC 7523 §2.1)

外部の発行者 (iss) が署名した JWT (assertion) を、Hydra のアクセストークンと交換する。公開鍵はクライアントではなく「信頼関係」として登録する。クライアント認証は別途 client_secret で行う。

```sh
node m2m/jwt-bearer-grant/setup.mjs      # 鍵ペア生成 + クライアント登録 + 信頼関係 (iss/sub/公開鍵) 登録
node m2m/jwt-bearer-grant/get-token.mjs  # assertion を /oauth2/token で交換 → introspect で確認
```

- 信頼関係の一覧: `curl -s http://localhost:4445/admin/trust/grants/jwt-bearer/issuers`

## クライアントの説明用プロパティ

クライアント登録時に、そのクライアントが何者かを残しておくためのプロパティ。特に次の3つを使う。

| プロパティ | 用途 | 一覧の絞り込み |
|---|---|---|
| `client_name` | ひと目で分かる名前 | `GET /admin/clients?client_name=...` |
| `owner` | 担当チーム (棚卸しで「このチームのクライアントを全部出す」) | `GET /admin/clients?owner=...` |
| `metadata` | 上記以外の説明全般 (自由な JSON: 説明、環境、チケット番号など) | 不可 |

```sh
curl -s -X POST http://localhost:4445/admin/clients -H 'Content-Type: application/json' -d '{
  "client_name": "order-batch",
  "owner": "team-commerce",
  "metadata": {"description": "夜間の受注集計バッチ", "env": "local", "ticket": "OPS-123"},
  "grant_types": ["client_credentials"],
  "scope": "read"
}'
```

- ほかに `contacts` (連絡先の配列)、`client_uri` (説明ページの URL) もある
- `logo_uri` / `policy_uri` / `tos_uri` はユーザーの同意画面向けで、M2M ではあまり使わない

## 設定内容の確認 (参照用 API)

### Admin API (http://localhost:4445)

| 見たいもの | エンドポイント |
|---|---|
| クライアント一覧 / 1件 | `GET /admin/clients` / `GET /admin/clients/{id}` |
| JWT Bearer グラントの信頼関係 | `GET /admin/trust/grants/jwt-bearer/issuers` |
| Hydra 自身の署名鍵 | `GET /admin/keys/{set}` (例: `hydra.openid.id-token`, `hydra.jwt.access-token`) |
| ユーザーの同意記録 | `GET /admin/oauth2/auth/sessions/consent?subject=...` (subject 必須) |
| トークンの中身 | `POST /admin/oauth2/introspect` (`token=...`) |
| バージョン / 稼働状態 | `GET /version` / `GET /health/ready` |

```sh
# 例: クライアント一覧を要点だけ表示
curl -s 'http://localhost:4445/admin/clients?page_size=100' \
  | jq -c '.[] | {client_id, client_name, owner, grant_types, token_endpoint_auth_method, scope, audience}'

# 例: 不要なクライアントを削除
curl -s -X DELETE http://localhost:4445/admin/clients/<client_id>
```

### Public API (http://localhost:4444)

| 見たいもの | エンドポイント |
|---|---|
| issuer・各エンドポイント・対応グラントなど | `GET /.well-known/openid-configuration` |
| トークン検証用の公開鍵 | `GET /.well-known/jwks.json` |

### API では見られないもの

- **client_secret**: ハッシュ化して保存されるため、登録時の応答でしか見られない
- **config/hydra.yml の設定内容** (secret、ログイン画面 URL、トークン有効期限など): API で取得する手段はない。ファイルかコンテナの環境変数を確認する (issuer やエンドポイントは openid-configuration に反映される)
