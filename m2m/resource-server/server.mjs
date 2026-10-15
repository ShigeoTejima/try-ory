// 簡単なリソースサーバー
// Authorization: Bearer <access_token> を Hydra の introspect で検証してから処理する
//
//   AUDIENCE=https://api-a.example.com PORT=8081 node m2m/resource-server/server.mjs
//   AUDIENCE=https://api-b.example.com PORT=8082 node m2m/resource-server/server.mjs
//
// 宛先の判断方法は2通り
//   - aud 方式 (デフォルト): トークンの aud に AUDIENCE が含まれているか、スコープは read / write
//   - スコープ方式 (SCOPE_PREFIX を指定): aud は見ず、スコープ <SCOPE_PREFIX>read / <SCOPE_PREFIX>write で宛先も判断する
//     audience パラメータを送れないクライアント (Salesforce の外部ログイン情報など) 向け
//       SCOPE_PREFIX=api-a. PORT=8081 node m2m/resource-server/server.mjs
import { createServer } from "node:http";

const ADMIN = process.env.HYDRA_ADMIN_URL ?? "http://localhost:4445";
const AUDIENCE = process.env.AUDIENCE ?? "https://api-a.example.com"; // 自分自身の識別子 (トークンの aud に含まれているべき値)
const SCOPE_PREFIX = process.env.SCOPE_PREFIX; // 例: "api-a." (指定するとスコープ方式)
const PORT = Number(process.env.PORT ?? 8081);

const items = [{ id: 1, name: "sample" }];

// エンドポイントごとに必要なスコープ
const routes = {
  "GET /items": { scope: "read", handle: () => ({ status: 200, body: items }) },
  "POST /items": {
    scope: "write",
    handle: (body) => {
      const item = { id: items.length + 1, name: body?.name ?? "no name" };
      items.push(item);
      return { status: 201, body: item };
    },
  },
};

// RFC 6750 のエラー応答 (WWW-Authenticate ヘッダでエラー種別を返す)
function authError(status, error, description) {
  return {
    status,
    headers: { "WWW-Authenticate": `Bearer error="${error}", error_description="${description}"` },
    body: { error, error_description: description },
  };
}

// introspect は無効なトークンでも HTTP 200 + { active: false } を返すので、本文で判定する
async function authenticate(req, requiredScope) {
  const match = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
  if (!match) return { error: { status: 401, headers: { "WWW-Authenticate": "Bearer" }, body: { error: "missing_token" } } };

  const res = await fetch(`${ADMIN}/admin/oauth2/introspect`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: match[1] }),
  });
  if (!res.ok) return { error: { status: 503, body: { error: "introspection_failed" } } };
  const info = await res.json();

  if (!info.active) return { error: authError(401, "invalid_token", "token is not active") };
  if (info.token_use !== "access_token") return { error: authError(401, "invalid_token", "not an access token") };
  if (SCOPE_PREFIX) {
    // スコープ方式: 自分宛てのスコープ (<SCOPE_PREFIX>xxx) が1つも無ければ別 API 宛てのトークンとみなす
    const scopes = info.scope?.split(" ") ?? [];
    if (!scopes.some((s) => s.startsWith(SCOPE_PREFIX))) return { error: authError(401, "invalid_token", `no scope for ${SCOPE_PREFIX}*`) };
    requiredScope = SCOPE_PREFIX + requiredScope;
  } else if (!info.aud?.includes(AUDIENCE)) {
    return { error: authError(401, "invalid_token", `audience must include ${AUDIENCE}`) };
  }
  if (!info.scope?.split(" ").includes(requiredScope)) return { error: authError(403, "insufficient_scope", `scope ${requiredScope} is required`) };
  return { token: info };
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : undefined;
}

function send(res, { status, headers = {}, body }) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

createServer(async (req, res) => {
  const route = routes[`${req.method} ${new URL(req.url, "http://x").pathname}`];
  if (!route) return send(res, { status: 404, body: { error: "not_found" } });

  const { token, error } = await authenticate(req, route.scope);
  if (error) {
    console.log(`${req.method} ${req.url} -> ${error.status} ${error.body.error}`);
    return send(res, error);
  }

  const result = route.handle(await readJson(req));
  console.log(`${req.method} ${req.url} -> ${result.status} (client_id=${token.client_id})`);
  send(res, result);
}).listen(PORT, () =>
  console.log(`resource server ${SCOPE_PREFIX ? `scope=${SCOPE_PREFIX}*` : `aud=${AUDIENCE}`} listening on http://localhost:${PORT}`),
);
