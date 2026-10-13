
const SESSION_SECONDS = 15 * 60;
const TELEGRAM_AUTH_MAX_AGE = 10 * 60;
const CHANNEL_USERNAME = "@CXSNS";
const SESSION_COOKIE = "rg_session";

const encoder = new TextEncoder();

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers
    }
  });
}

function base64urlEncode(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64urlDecode(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function signText(text, secret) {
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(text)
  );
  return base64urlEncode(new Uint8Array(signature));
}

async function verifyText(text, signature, secret) {
  try {
    const key = await hmacKey(secret);
    return await crypto.subtle.verify(
      "HMAC",
      key,
      base64urlDecode(signature),
      encoder.encode(text)
    );
  } catch {
    return false;
  }
}

async function verifyTelegramLogin(user, botToken) {
  if (!user || typeof user !== "object" || !user.hash) return false;

  const authDate = Number(user.auth_date);
  const now = Math.floor(Date.now() / 1000);

  if (
    !Number.isFinite(authDate) ||
    authDate > now + 30 ||
    now - authDate > TELEGRAM_AUTH_MAX_AGE
  ) {
    return false;
  }

  if (!/^\d+$/.test(String(user.id))) return false;

  const fields = Object.keys(user)
    .filter(key => key !== "hash" && user[key] !== undefined && user[key] !== null)
    .sort()
    .map(key => `${key}=${user[key]}`)
    .join("\n");

  const secretBytes = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(botToken)
  );

  const secretKey = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const expectedBytes = await crypto.subtle.sign(
    "HMAC",
    secretKey,
    encoder.encode(fields)
  );

  const expectedHash = Array.from(new Uint8Array(expectedBytes))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");

  if (!/^[a-f0-9]{64}$/i.test(String(user.hash))) return false;

  return expectedHash === String(user.hash).toLowerCase();
}

async function checkMembership(botToken, userId) {
  try {
    const url = new URL(
      `https://api.telegram.org/bot${botToken}/getChatMember`
    );
    url.searchParams.set("chat_id", CHANNEL_USERNAME);
    url.searchParams.set("user_id", String(userId));

    const response = await fetch(url.toString());
    if (!response.ok) return false;

    const result = await response.json();
    if (!result.ok || !result.result) return false;

    const member = result.result;

    return (
      member.status === "creator" ||
      member.status === "administrator" ||
      member.status === "member" ||
      (member.status === "restricted" && member.is_member === true)
    );
  } catch {
    return false;
  }
}

async function createSession(user, botToken) {
  const payload = {
    id: String(user.id),
    first_name: String(user.first_name || "").slice(0, 100),
    username: String(user.username || "").slice(0, 100),
    exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS
  };

  const payloadPart = base64urlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = await signText(payloadPart, botToken);

  return `${payloadPart}.${signature}`;
}

async function readSession(request, botToken) {
  const cookieHeader = request.headers.get("Cookie") || "";
  const cookies = cookieHeader.split(";");

  let token = "";
  for (const cookie of cookies) {
    const item = cookie.trim();
    if (item.startsWith(`${SESSION_COOKIE}=`)) {
      token = item.slice(SESSION_COOKIE.length + 1);
      break;
    }
  }

  if (!token) return null;

  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [payloadPart, signature] = parts;
  if (!(await verifyText(payloadPart, signature, botToken))) return null;

  try {
    const payload = JSON.parse(
      new TextDecoder().decode(base64urlDecode(payloadPart))
    );

    if (
      !payload.id ||
      !Number.isFinite(payload.exp) ||
      payload.exp <= Math.floor(Date.now() / 1000)
    ) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

function sessionCookie(value, maxAge) {
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function isProxyDataPath(pathname) {
  return (
    /\/proxies[^/]*\.json$/i.test(pathname) ||
    /\/all_proxies\.txt$/i.test(pathname) ||
    /\/censorship_resistant\.txt$/i.test(pathname)
  );
}

function sameOrigin(request) {
  const origin = request.headers.get("Origin");
  return origin === new URL(request.url).origin;
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const botToken = env.TELEGRAM_BOT_TOKEN;

  // Temporary safe diagnostic: report binding presence only, never secret values.
  if (pathname === "/api/diagnostic/config") {
    return json({
      hasBotToken: Boolean(botToken),
      hasProxyData: Boolean(env.PROXY_DATA),
      hasAssets: Boolean(env.ASSETS)
    });
  }

  if (!botToken) {
    return json({ ok: false, error: "Server configuration error" }, 500);
  }

  // Bot-based login flow. Login records use a dedicated key prefix in KV.
  if (pathname === "/api/auth/bot/start" && request.method === "POST") {
    if (!sameOrigin(request)) return json({ ok: false, error: "Invalid origin" }, 403);
    if (!env.PROXY_DATA) return json({ ok: false, error: "Login storage is not configured" }, 500);
    const stateBytes = crypto.getRandomValues(new Uint8Array(24));
    const state = Array.from(stateBytes, b => b.toString(16).padStart(2, "0")).join("");
    await env.PROXY_DATA.put("login:" + state, JSON.stringify({ status: "pending", created: Date.now() }), { expirationTtl: 600 });
    return json({ ok: true, state, botUrl: "https://t.me/AccessIDBot?start=login_" + state });
  }

  if (pathname === "/api/auth/bot/status" && request.method === "GET") {
    if (!env.PROXY_DATA) return json({ ok: false, error: "Login storage is not configured" }, 500);
    const state = url.searchParams.get("state") || "";
    if (!/^[a-f0-9]{48}$/.test(state)) return json({ ok: false, error: "Invalid login state" }, 400);
    const key = "login:" + state;
    const record = await env.PROXY_DATA.get(key, "json");
    if (!record) return json({ ok: false, status: "expired", error: "登录请求已过期，请重新开始。" }, 410);
    if (record.status !== "complete") return json({ ok: true, status: "pending" });
    await env.PROXY_DATA.delete(key);
    if (!record.user || !record.user.id) return json({ ok: false, status: "failed", error: "Telegram 身份验证失败。" }, 401);
    if (!record.subscribed) return json({ ok: false, status: "not_subscribed", error: "请先加入 @CXSNS 官方频道，再重新登录。" }, 403);
    const token = await createSession(record.user, botToken);
    return json({ ok: true, status: "authenticated" }, 200, { "Set-Cookie": sessionCookie(token, SESSION_SECONDS) });
  }

  if (pathname === "/api/telegram/webhook/setup" && request.method === "POST") {
    const expectedSecret = env.TELEGRAM_WEBHOOK_SECRET;
    if (!expectedSecret || request.headers.get("X-Setup-Secret") !== expectedSecret) {
      return json({ ok: false, error: "Unauthorized setup request" }, 401);
    }
    const webhookUrl = "https://kisss.kdns.fr/api/telegram/webhook";
    try {
      const response = await fetch("https://api.telegram.org/bot" + botToken + "/setWebhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: webhookUrl,
          secret_token: expectedSecret,
          allowed_updates: ["message"],
          drop_pending_updates: false
        })
      });
      const result = await response.json();
      return json({ ok: Boolean(result.ok), description: result.description || (result.ok ? "Webhook configured" : "Telegram rejected setup") }, result.ok ? 200 : 502);
    } catch {
      return json({ ok: false, error: "Unable to reach Telegram API" }, 502);
    }
  }

  if (pathname === "/api/telegram/webhook" && request.method === "POST") {
    const expectedSecret = env.TELEGRAM_WEBHOOK_SECRET;
    if (!expectedSecret || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== expectedSecret) {
      return json({ ok: false, error: "Unauthorized webhook" }, 401);
    }
    if (!env.PROXY_DATA) return json({ ok: false, error: "Login storage is not configured" }, 500);
    let update;
    try { update = await request.json(); } catch { return json({ ok: false }, 400); }
    const message = update && update.message;
    const from = message && message.from;
    const textValue = String((message && message.text) || "");
    const match = textValue.match(/^\/start\s+login_([a-f0-9]{48})$/);
    if (!from || !/^\d+$/.test(String(from.id)) || !match) return json({ ok: true });
    const state = match[1];
    const key = "login:" + state;
    const record = await env.PROXY_DATA.get(key, "json");
    if (!record || record.status !== "pending") return json({ ok: true });
    const subscribed = await checkMembership(botToken, from.id);
    const user = {
      id: String(from.id),
      first_name: String(from.first_name || "").slice(0, 100),
      username: String(from.username || "").slice(0, 100)
    };
    await env.PROXY_DATA.put(key, JSON.stringify({ status: "complete", user, subscribed }), { expirationTtl: 300 });
    const reply = subscribed
      ? "身份已验证！请返回资源公社代理助手页面，系统正在完成登录。"
      : "暂未检测到你加入 @CXSNS。请先加入官方频道，再回到网站重新登录。";
    try {
      await fetch("https://api.telegram.org/bot" + botToken + "/sendMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: String(from.id), text: reply })
      });
    } catch {}
    return json({ ok: true });
  }

  // Mobile-friendly Telegram Login Widget redirect callback.
  // Telegram sends the signed user fields as query parameters to this endpoint.
  if (pathname === "/api/auth/telegram/callback" && request.method === "GET") {
    const params = url.searchParams;
    const user = {};
    for (const key of ["id", "first_name", "last_name", "username", "photo_url", "auth_date", "hash"]) {
      const value = params.get(key);
      if (value !== null) user[key] = value;
    }

    const redirectTo = (result) => Response.redirect(
      `https://kisss.kdns.fr/?login=${encodeURIComponent(result)}#telegram-access`,
      303
    );

    if (!(await verifyTelegramLogin(user, botToken))) {
      return redirectTo("verification_failed");
    }

    const subscribed = await checkMembership(botToken, user.id);
    if (!subscribed) {
      return redirectTo("not_subscribed");
    }

    const token = await createSession(user, botToken);
    return new Response(null, {
      status: 303,
      headers: {
        "Location": "https://kisss.kdns.fr/#proxies",
        "Cache-Control": "no-store",
        "Set-Cookie": sessionCookie(token, SESSION_SECONDS)
      }
    });
  }

  if (pathname === "/api/auth/telegram" && request.method === "POST") {
    if (!sameOrigin(request)) {
      return json({ ok: false, error: "Invalid origin" }, 403);
    }

    let user;
    try {
      user = await request.json();
    } catch {
      return json({ ok: false, error: "Invalid request" }, 400);
    }

    if (!(await verifyTelegramLogin(user, botToken))) {
      return json({ ok: false, error: "Telegram verification failed" }, 401);
    }

    const subscribed = await checkMembership(botToken, user.id);

    if (!subscribed) {
      return json({
        ok: false,
        subscribed: false,
        error: "请先加入 Telegram 官方频道 @CXSNS"
      }, 403);
    }

    const token = await createSession(user, botToken);

    return json(
      {
        ok: true,
        authenticated: true,
        subscribed: true,
        user: {
          id: String(user.id),
          first_name: user.first_name || "",
          username: user.username || ""
        }
      },
      200,
      { "Set-Cookie": sessionCookie(token, SESSION_SECONDS) }
    );
  }

  if (pathname === "/api/auth/status" && request.method === "GET") {
    const session = await readSession(request, botToken);

    if (!session) {
      return json({ ok: true, authenticated: false, subscribed: false });
    }

    const subscribed = await checkMembership(botToken, session.id);

    if (!subscribed) {
      return json(
        { ok: true, authenticated: false, subscribed: false },
        200,
        { "Set-Cookie": clearSessionCookie() }
      );
    }

    return json({
      ok: true,
      authenticated: true,
      subscribed: true,
      user: {
        id: session.id,
        first_name: session.first_name || "",
        username: session.username || ""
      }
    });
  }

  if (pathname === "/api/auth/logout" && request.method === "POST") {
    if (!sameOrigin(request)) {
      return json({ ok: false, error: "Invalid origin" }, 403);
    }

    return json(
      { ok: true },
      200,
      { "Set-Cookie": clearSessionCookie() }
    );
  }

  if (isProxyDataPath(pathname)) {
    const session = await readSession(request, botToken);

    if (!session) {
      return json({ ok: false, error: "请先登录 Telegram" }, 401);
    }

    if (!(await checkMembership(botToken, session.id))) {
      return json({ ok: false, error: "请先加入官方频道 @CXSNS" }, 403);
    }

    if (pathname !== "/proxies.json" || request.method !== "GET") {
      return json({ ok: false, error: "Not found" }, 404);
    }

    if (!env.PROXY_DATA) {
      return json({ ok: false, error: "Proxy storage is not configured" }, 500);
    }

    const proxyData = await env.PROXY_DATA.get("proxies.json", "json");

    if (!proxyData || !Array.isArray(proxyData.proxies)) {
      return json({ ok: false, error: "Proxy data is not ready" }, 503);
    }

    return json(proxyData, 200, {
      "X-Content-Type-Options": "nosniff"
    });
  }

  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch {
      return json({ ok: false, error: "Internal server error" }, 500);
    }
  }
};
