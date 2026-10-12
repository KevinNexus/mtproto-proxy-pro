
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

  if (!botToken) {
    return json({ ok: false, error: "Server configuration error" }, 500);
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
