
/* 资源公社·代理助手
   Telegram 登录验证 + 频道成员检查 + 代理列表
*/
(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);

  const rowsEl = $("#rows");
  const loadingEl = $("#loading");
  const emptyEl = $("#empty");
  const shownEl = $("#shown");
  const searchEl = $("#search");
  const countryEl = $("#country");
  const sortEl = $("#sort");
  const resistEl = $("#resistonly");
  const toastEl = $("#toast");
  const bannerEl = $("#banner");
  const bannerTextEl = $("#banner-text");

  const authStatusEl = $("#auth-status");
  const loginWidgetEl = $("#telegram-login-widget");
  const joinChannelEl = $("#join-channel");
  const authActionsEl = $("#auth-actions");
  const logoutButtonEl = $("#logout-button");
  const accessRequiredEl = $("#access-required");
  const proxyContentEl = $("#proxy-content");

  let ALL = [];
  let CURRENT_STATS = {};
  let authenticated = false;
  let loadingProxies = false;

  const CENSORED = {
    IR: "Iran", RU: "Russia", CN: "China", TM: "Turkmenistan",
    VN: "Vietnam", VE: "Venezuela", PK: "Pakistan",
    BY: "Belarus", UZ: "Uzbekistan", MM: "Myanmar"
  };

  const COUNTRY_NAMES = new Intl.DisplayNames(["en"], {
    type: "region"
  });

  function flag(cc) {
    if (!cc || !/^[A-Z]{2}$/.test(cc) || cc === "XX") {
      return "🌐";
    }

    const A = 0x1f1e6;
    return String.fromCodePoint(
      A + cc.charCodeAt(0) - 65,
      A + cc.charCodeAt(1) - 65
    );
  }

  function countryName(cc) {
    if (!cc || cc === "??" || cc === "XX") return "Unknown";

    try {
      return COUNTRY_NAMES.of(cc) || cc;
    } catch {
      return cc;
    }
  }

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[c]));
  }

  function latClass(ms) {
    if (ms < 120) return "lat--fast";
    if (ms < 350) return "lat--mid";
    return "lat--slow";
  }

  function relTime(iso) {
    const time = Date.parse(iso);
    if (Number.isNaN(time)) return "—";

    const mins = Math.round((Date.now() - time) / 60000);
    if (mins < 1) return "刚刚";
    if (mins < 60) return `${mins} 分钟前`;

    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} 小时前`;

    return `${Math.round(hours / 24)} 天前`;
  }

  function tmeHref(p) {
    if (p.link) return p.link;

    return `https://t.me/proxy?server=${encodeURIComponent(p.server)}&port=${encodeURIComponent(p.port)}&secret=${encodeURIComponent(p.secret)}`;
  }

  function tgHref(p) {
    return `tg://proxy?server=${encodeURIComponent(p.server)}&port=${encodeURIComponent(p.port)}&secret=${encodeURIComponent(p.secret)}`;
  }

  function fakeTLSDomain(secret) {
    if (typeof secret !== "string" ||
        !secret.toLowerCase().startsWith("ee")) {
      return "";
    }

    const hex = secret.slice(2);

    if (!hex || hex.length % 2 !== 0 ||
        !/^[0-9a-f]+$/i.test(hex)) {
      return "";
    }

    try {
      const bytes = [];

      for (let i = 0; i < hex.length; i += 2) {
        bytes.push(parseInt(hex.slice(i, i + 2), 16));
      }

      let domain = "";

      for (const byte of bytes) {
        const ch = String.fromCharCode(byte);

        if (/[a-z0-9.-]/i.test(ch)) {
          domain += ch;
        } else {
          break;
        }
      }

      domain = domain.toLowerCase().replace(/\.$/, "");

      if (domain.length < 4 ||
          domain.length > 253 ||
          !domain.includes(".")) {
        return "";
      }

      if (!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain)) {
        return "";
      }

      if (domain.split(".").some((part) =>
        !part ||
        part.length > 63 ||
        part.startsWith("-") ||
        part.endsWith("-")
      )) {
        return "";
      }

      return domain;
    } catch {
      return "";
    }
  }

  function isResistant(p) {
    return p.type === "ee" &&
      Number(p.port) === 443 &&
      Boolean(fakeTLSDomain(p.secret));
  }

  function resilienceTier(score) {
    if (score >= 75) return { cls: "res--high", label: "高" };
    if (score >= 50) return { cls: "res--mid", label: "中" };
    return { cls: "res--low", label: "低" };
  }

  function showToast(message) {
    if (!toastEl) {
      console.log(message);
      return;
    }

    toastEl.textContent = message;
    toastEl.hidden = false;

    requestAnimationFrame(() => toastEl.classList.add("show"));

    clearTimeout(showToast.timer);

    showToast.timer = setTimeout(() => {
      toastEl.classList.remove("show");

      setTimeout(() => {
        toastEl.hidden = true;
      }, 250);
    }, 2200);
  }

  function setAuthMessage(message) {
    if (authStatusEl) authStatusEl.textContent = message;
  }

  function showLogin(message) {
    authenticated = false;
    ALL = [];

    if (proxyContentEl) proxyContentEl.hidden = true;
    if (accessRequiredEl) accessRequiredEl.hidden = false;
    if (loginWidgetEl) loginWidgetEl.hidden = false;
    if (authActionsEl) authActionsEl.hidden = true;
    if (joinChannelEl) joinChannelEl.hidden = true;

    if (rowsEl) rowsEl.replaceChildren();
    if (shownEl) shownEl.textContent = "0";
    if (loadingEl) loadingEl.hidden = true;
    if (emptyEl) emptyEl.hidden = true;

    setAuthMessage(message || "请使用 Telegram 登录，并加入官方频道 @CXSNS。");
  }

  function showLoggedIn() {
    authenticated = true;

    if (proxyContentEl) proxyContentEl.hidden = false;
    if (accessRequiredEl) accessRequiredEl.hidden = true;
    if (loginWidgetEl) loginWidgetEl.hidden = true;
    if (authActionsEl) authActionsEl.hidden = false;
    if (joinChannelEl) joinChannelEl.hidden = true;

    setAuthMessage("验证成功，正在加载代理列表……");
  }

  async function readJson(response) {
    try {
      return await response.json();
    } catch {
      return {};
    }
  }

  async function requestJson(url, options = {}) {
    const response = await fetch(url, {
      credentials: "same-origin",
      cache: "no-store",
      ...options,
      headers: {
        "Accept": "application/json",
        ...(options.headers || {})
      }
    });

    const data = await readJson(response);

    return { response, data };
  }

  // 登录成功后，才请求受保护的代理数据。
  async function loadProxies() {
    if (!authenticated || loadingProxies) return;

    loadingProxies = true;

    if (loadingEl) {
      loadingEl.hidden = false;
      loadingEl.textContent = "正在加载代理列表……";
    }

    try {
      const { response, data } = await requestJson("/proxies.json");

      if (response.status === 401 || response.status === 403) {
        showLogin("登录状态失效，或尚未加入官方频道，请重新验证。");
        return;
      }

      if (!response.ok) {
        throw new Error(`代理数据请求失败：HTTP ${response.status}`);
      }

      if (!Array.isArray(data.proxies)) {
        throw new Error("代理数据格式不正确。");
      }

      ALL = data.proxies;
      CURRENT_STATS = data;

      if (loadingEl) loadingEl.hidden = true;

      fillStats(data);
      fillCountryFilter(data);
      applyFilters();
      detectCountry();

      setAuthMessage("已通过验证，可以使用代理列表。");
    } catch (error) {
      console.error("代理列表加载失败：", error);

      if (loadingEl) {
        loadingEl.hidden = false;
        loadingEl.textContent =
          "代理列表加载失败，请稍后刷新。如果问题持续存在，请联系管理员。";
      }

      showToast("代理列表加载失败");
    } finally {
      loadingProxies = false;
    }
  }

  // Telegram Login Widget 会调用这个全局函数。
  window.onTelegramAuth = async function (user) {
    if (!user || !user.id || !user.hash) {
      setAuthMessage("Telegram 登录信息不完整，请重新登录。");
      return;
    }

    setAuthMessage("正在验证 Telegram 身份及频道成员资格……");

    if (loginWidgetEl) loginWidgetEl.hidden = true;

    try {
      const { response, data } = await requestJson(
        "/api/auth/telegram",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(user)
        }
      );

      if (!response.ok) {
        const reason = String(
          data.error || data.message || ""
        ).toLowerCase();

        if (
          response.status === 403 &&
          /member|channel|join|subscribe|not.?joined/.test(reason)
        ) {
          setAuthMessage("请先加入资源公社官方频道 @CXSNS，再重新登录。");

          if (joinChannelEl) {
            joinChannelEl.href = "https://t.me/CXSNS";
            joinChannelEl.hidden = false;
          }

          if (loginWidgetEl) loginWidgetEl.hidden = false;
          return;
        }

        if (response.status === 401 || response.status === 403) {
          setAuthMessage(
            "身份验证未通过。请确认登录账号正确，并已加入 @CXSNS。"
          );
        } else {
          setAuthMessage(
            `验证服务暂时不可用（HTTP ${response.status}），请稍后重试。`
          );
        }

        if (loginWidgetEl) loginWidgetEl.hidden = false;
        return;
      }

      // 只有服务器明确确认认证成功，才展示代理内容。
      if (data.authenticated !== true && data.ok !== true) {
        setAuthMessage("服务器未确认登录成功，请稍后重试。");
        if (loginWidgetEl) loginWidgetEl.hidden = false;
        return;
      }

      showLoggedIn();
      await loadProxies();
    } catch (error) {
      console.error("Telegram 登录验证失败：", error);
      setAuthMessage("无法连接验证服务，请稍后重试。");

      if (loginWidgetEl) loginWidgetEl.hidden = false;
    }
  };


  // Mobile-friendly login via the Telegram bot; no telegram.org widget script required.
  const botLoginButton = $("#bot-login-button");
  let botPollTimer = null;
  let botPollState = "";

  async function pollBotLogin(state) {
    if (botPollState !== state) return;
    try {
      const { response, data } = await requestJson("/api/auth/bot/status?state=" + encodeURIComponent(state));
      if (data.status === "pending") {
        botPollTimer = setTimeout(() => pollBotLogin(state), 800);
        return;
      }
      if (response.ok && data.status === "authenticated") {
        botPollState = "";
        showLoggedIn();
        await loadProxies();
        return;
      }
      botPollState = "";
      setAuthMessage(data.error || "登录请求已失效，请重新开始。");
      if (loginWidgetEl) loginWidgetEl.hidden = false;
    } catch (error) {
      console.error("Bot 登录状态检查失败：", error);
      botPollTimer = setTimeout(() => pollBotLogin(state), 2500);
    }
  }

  if (botLoginButton) {
    botLoginButton.addEventListener("click", async () => {
      if (botPollTimer) clearTimeout(botPollTimer);
      botPollState = "";
      setAuthMessage("正在创建安全登录请求……");
      botLoginButton.disabled = true;
      const popup = window.open("about:blank", "_blank");
      try {
        const { response, data } = await requestJson("/api/auth/bot/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}"
        });
        if (!response.ok || !data.ok || !data.state || !data.botUrl) {
          if (popup) popup.close();
          throw new Error(data.error || "无法创建登录请求");
        }
        if (popup) popup.location.href = data.botUrl;
        else window.location.href = data.botUrl;
        botPollState = data.state;
        setAuthMessage("请在 Telegram 机器人中点击开始；完成身份和频道验证后会自动登录。此请求 10 分钟内有效。");
        pollBotLogin(data.state);
      } catch (error) {
        if (popup) popup.close();
        console.error("Bot 登录启动失败：", error);
        setAuthMessage("无法启动机器人登录，请刷新页面后重试。");
      } finally {
        botLoginButton.disabled = false;
      }
    });
  }

  async function checkAuthStatus() {
    showLogin("正在检查登录状态……");

    try {
      const { response, data } = await requestJson("/api/auth/status");

      if (
        response.ok &&
        data.authenticated === true
      ) {
        showLoggedIn();
        await loadProxies();
        return;
      }

      const loginResult = new URLSearchParams(window.location.search).get("login");
      if (loginResult === "not_subscribed") {
        showLogin("登录成功，但你尚未加入 @CXSNS。请先加入官方频道，再重新登录验证。");
      } else if (loginResult === "verification_failed") {
        showLogin("Telegram 登录信息验证失败，请返回频道链接重新打开网站后再试。");
      } else {
        showLogin("请使用 Telegram 登录，并加入官方频道 @CXSNS。");
      }

      if (loginResult) {
        const cleanUrl = new URL(window.location.href);
        cleanUrl.searchParams.delete("login");
        window.history.replaceState({}, "", cleanUrl.pathname + cleanUrl.search + cleanUrl.hash);
      }
    } catch (error) {
      console.error("登录状态检查失败：", error);

      showLogin(
        "暂时无法连接验证服务。请稍后刷新页面，或联系管理员。"
      );
    }
  }

  if (logoutButtonEl) {
    logoutButtonEl.addEventListener("click", async () => {
      try {
        await requestJson("/api/auth/logout", {
          method: "POST"
        });
      } catch (error) {
        console.error("退出登录请求失败：", error);
      }

      showLogin("已退出登录。请重新验证后访问代理列表。");
      showToast("已退出登录");
    });
  }

  function fillStats(data) {
    const countEl = $('[data-stat="count"]');
    const resistantEl = $('[data-stat="resistant"]');
    const countriesEl = $('[data-stat="countries"]');
    const updatedEl = $('[data-stat="updated"]');

    if (countEl) {
      countEl.textContent =
        (data.count ?? ALL.length).toLocaleString();
    }

    if (resistantEl) {
      const count = typeof data.censorship_resistant === "number"
        ? data.censorship_resistant
        : ALL.filter(isResistant).length;

      resistantEl.textContent = count.toLocaleString();
    }

    if (countriesEl) {
      countriesEl.textContent = Object.keys(
        data.countries || {}
      ).filter((country) => country !== "??").length;
    }

    if (updatedEl) {
      const updated = data.generated_at_utc || data.updatedAt || "";
      updatedEl.textContent = relTime(updated);
      updatedEl.title = updated;
    }
  }

  function fillCountryFilter(data) {
    if (!countryEl) return;

    // 避免重新加载时重复添加国家选项。
    countryEl.replaceChildren();

    const allOption = document.createElement("option");
    allOption.value = "";
    allOption.textContent = "所有国家";
    countryEl.appendChild(allOption);

    const countries = data.countries || {};

    // 如果 JSON 没有 countries 统计，就从代理数据计算。
    const entries = Object.entries(countries).length
      ? Object.entries(countries)
      : Object.entries(
          ALL.reduce((result, proxy) => {
            const cc = proxy.country || "??";
            result[cc] = (result[cc] || 0) + 1;
            return result;
          }, {})
        );

    entries
      .filter(([cc]) => cc !== "??")
      .sort((a, b) => b[1] - a[1])
      .forEach(([cc, count]) => {
        const option = document.createElement("option");
        option.value = cc;
        option.textContent =
          `${flag(cc)} ${countryName(cc)} (${count})`;

        countryEl.appendChild(option);
      });
  }

  function reachChips(proxy) {
    if (!Array.isArray(proxy.reachable_from) ||
        !proxy.reachable_from.length) {
      return "";
    }

    return " " + proxy.reachable_from.map((cc) =>
      `<span class="reach-chip" title="TCP 可达性报告：${esc(countryName(cc))}">${flag(cc)} ${esc(cc)}</span>`
    ).join(" ");
  }

  function rowHTML(proxy) {
    const name = countryName(proxy.country);

    const typeLabel = {
      ee: "FakeTLS",
      dd: "Secure",
      plain: "Basic"
    }[proxy.type] || proxy.type || "Unknown";

    const statusLabel = proxy.status === "handshake_ok"
      ? '<span class="status-tag" title="TLS 握手完成，但不保证 Telegram 一定可用">● TLS 已验证</span>'
      : '<span class="status-tag status-tag--reach" title="仅代表 TCP 可连接，不保证 Telegram 可用">● TCP 检测</span>';

    const tier = resilienceTier(proxy.resilience || 0);
    const link = tmeHref(proxy);
    const telegramLink = tgHref(proxy);
    const latency = typeof proxy.latency_ms === "number"
      ? proxy.latency_ms
      : null;

    return `<tr>
      <td class="col-country" data-label="国家">
        <span class="td-country">
          <span class="flag" aria-hidden="true">${flag(proxy.country)}</span>
          <span>${esc(name)}</span>
        </span>
      </td>
      <td class="col-server" data-label="服务器">
        <span class="server">${esc(proxy.server)}<span class="port">:${esc(proxy.port)}</span></span>
        <br>${statusLabel}${reachChips(proxy)}
      </td>
      <td class="col-type" data-label="类型">
        <span class="badge badge--${esc(proxy.type)}">${esc(typeLabel)}</span>
        <span class="badge res ${tier.cls}" title="结构估算，不是实际成功率">🛡 ${tier.label}</span>
      </td>
      <td class="col-num" data-label="延迟">
        <span class="lat ${latClass(latency ?? 9999)}">${latency ?? "—"} ms</span>
      </td>
      <td class="col-num" data-label="在线率">
        <span class="uptime">${esc(proxy.uptime_pct ?? 0)}%</span>
      </td>
      <td class="col-actions" data-label="连接">
        <div class="actions">
          <button class="btn btn--icon" type="button"
            data-copy="${esc(link)}"
            aria-label="复制 ${esc(proxy.server)} 的代理链接"
            title="复制链接">
            <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="none" stroke="currentColor" stroke-width="2"
                stroke-linecap="round" stroke-linejoin="round"
                d="M9 9h10v10H9zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>
            </svg>
          </button>
          <a class="btn btn--go" href="${esc(link)}"
            data-tg="${esc(telegramLink)}"
            target="_blank" rel="noopener"
            aria-label="在 Telegram 中连接 ${esc(proxy.server)}">连接 Telegram</a>
        </div>
      </td>
    </tr>`;
  }

  function applyFilters() {
    if (!authenticated || !rowsEl) return;

    const query = searchEl ? searchEl.value.trim().toLowerCase() : "";
    const country = countryEl ? countryEl.value : "";
    const resistantOnly = resistEl ? resistEl.checked : false;
    const sort = sortEl ? sortEl.value : "resilience";

    let list = ALL.filter((proxy) => {
      if (country && proxy.country !== country) return false;
      if (resistantOnly && !isResistant(proxy)) return false;

      const server = String(proxy.server || "").toLowerCase();
      const cc = String(proxy.country || "").toLowerCase();
      const countryLabel = countryName(proxy.country).toLowerCase();

      return !query ||
        server.includes(query) ||
        countryLabel.includes(query) ||
        cc.includes(query);
    });

    if (sort === "resilience") {
      list.sort((a, b) =>
        (b.resilience || 0) - (a.resilience || 0) ||
        (a.latency_ms ?? 999999) - (b.latency_ms ?? 999999)
      );
    } else if (sort === "latency") {
      list.sort((a, b) =>
        (a.latency_ms ?? 999999) - (b.latency_ms ?? 999999)
      );
    } else if (sort === "uptime") {
      list.sort((a, b) =>
        (b.uptime_pct ?? 0) - (a.uptime_pct ?? 0) ||
        (a.latency_ms ?? 999999) - (b.latency_ms ?? 999999)
      );
    } else if (sort === "country") {
      list.sort((a, b) =>
        countryName(a.country).localeCompare(countryName(b.country)) ||
        (a.latency_ms ?? 999999) - (b.latency_ms ?? 999999)
      );
    }

    rowsEl.innerHTML = list.map(rowHTML).join("");

    if (shownEl) shownEl.textContent = list.length.toLocaleString();
    if (emptyEl) emptyEl.hidden = list.length !== 0;
  }

  function detectCountry() {
    if (!authenticated || !bannerEl || !bannerTextEl) return;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);

    fetch("https://api.country.is/", {
      signal: controller.signal
    })
      .then((response) => response.ok ? response.json() : null)
      .then((data) => {
        clearTimeout(timeout);

        if (!authenticated) return;

        const cc = data && data.country;
        if (!cc || !CENSORED[cc]) return;

        const reachable = ALL.some((proxy) =>
          (proxy.reachable_from || []).includes(cc)
        );

        bannerTextEl.innerHTML =
          `检测到所在地区可能限制 Telegram：<strong>${esc(CENSORED[cc])}</strong>。` +
          "建议优先尝试 FakeTLS 代理。" +
          (reachable
            ? ` 有来自该地区的 TCP 可达报告 ${flag(cc)}。`
            : " 当前没有来自该地区的可达报告。") +
          " 检测结果不保证代理一定可用。";

        bannerEl.hidden = false;

        if (resistEl) resistEl.checked = true;
        if (sortEl) sortEl.value = "resilience";

        applyFilters();
      })
      .catch(() => clearTimeout(timeout));
  }

  function debounce(fn, ms) {
    let timer;

    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }

  // 复制代理链接。
  if (rowsEl) {
    rowsEl.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-copy]");
      if (!button || !authenticated) return;

      const link = button.getAttribute("data-copy");

      try {
        await navigator.clipboard.writeText(link);
        showToast("代理链接已复制");
      } catch {
        const textarea = document.createElement("textarea");
        textarea.value = link;
        document.body.appendChild(textarea);
        textarea.select();

        try {
          document.execCommand("copy");
          showToast("代理链接已复制");
        } catch {
          showToast("复制失败，请长按链接复制");
        }

        textarea.remove();
      }
    });

    // 优先打开 Telegram 应用，无法打开时回退到网页链接。
    rowsEl.addEventListener("click", (event) => {
      const anchor = event.target.closest("a.btn--go");

      if (!anchor || !anchor.dataset.tg || !authenticated) return;

      event.preventDefault();

      const webLink = anchor.getAttribute("href");
      const appLink = anchor.dataset.tg;
      let switchedAway = false;

      const markSwitched = () => {
        switchedAway = true;
      };

      window.addEventListener("blur", markSwitched, { once: true });

      const onVisibility = () => {
        if (document.hidden) {
          markSwitched();
          document.removeEventListener("visibilitychange", onVisibility);
        }
      };

      document.addEventListener("visibilitychange", onVisibility);

      window.location.href = appLink;

      window.setTimeout(() => {
        document.removeEventListener("visibilitychange", onVisibility);

        if (!switchedAway) {
          window.location.href = webLink;
        }
      }, 1800);

      showToast("正在打开 Telegram……");
    });
  }

  if (searchEl) {
    searchEl.addEventListener("input", debounce(applyFilters, 120));
  }

  if (countryEl) {
    countryEl.addEventListener("change", applyFilters);
  }

  if (sortEl) {
    sortEl.addEventListener("change", applyFilters);
  }

  if (resistEl) {
    resistEl.addEventListener("change", applyFilters);
  }

  // 页面启动时先验证会话，不再直接公开请求代理列表。
  checkAuthStatus();
})();
