/* Same-origin verified assets. No backend credential or GitHub write token. */
(async () => {
  const manifestURL = new URL("./manifest.json", location.href);
  const inject = (id, text, type) => {
    let e = document.getElementById(id);
    if (!e) {
      e = document.createElement(type === "style" ? "style" : "script");
      e.id = id;
      if (type !== "style") e.type = type;
      document.head.appendChild(e);
    }
    e.textContent = type === "application/json" ? text.replaceAll("<", "\\u003c") : text;
  };
  let current,
    businessLoaded = false,
    businessJob = null,
    checking = false;
  const status = (state, message = "") => {
    const detail = {
      state,
      message,
      checkedAt: new Date().toISOString(),
      lastSuccessAt: current?.lastSuccessAt,
    };
    inject("delivery-update-status", JSON.stringify(detail), "application/json");
    window.dispatchEvent(new CustomEvent("delivery-update-status", { detail }));
  };
  async function getManifest() {
    const r = await fetch(manifestURL, { cache: "no-store" });
    if (!r.ok) throw Error("最新版本暂时无法读取");
    return r.json();
  }
  async function load(part) {
    const u = new URL(part.file, manifestURL);
    if (u.origin !== location.origin) throw Error("数据文件来源不一致");
    const r = await fetch(u);
    if (!r.ok) throw Error("部分经营数据未读取成功");
    const bytes = await r.arrayBuffer();
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (x) =>
      x.toString(16).padStart(2, "0"),
    ).join("");
    if (hash !== part.sha256) throw Error("数据文件校验未通过");
    return new Response(
      new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")),
    ).text();
  }
  async function ensureBusiness() {
    if (businessLoaded) return JSON.parse(document.getElementById("delivery-business").textContent);
    if (businessJob) return businessJob;
    businessJob = (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const part = current.files.business,
          raw = await load(part);
        if (part.sha256 !== current.files.business.sha256) continue;
        const b = JSON.parse(raw);
        inject("delivery-business", raw, "application/json");
        businessLoaded = true;
        window.dispatchEvent(new CustomEvent("delivery-business-ready", { detail: b }));
        return b;
      }
      throw Error("版本正在更新，请稍后重试");
    })().finally(() => {
      businessJob = null;
    });
    return businessJob;
  }
  window.addEventListener("delivery-load-business", (e) => {
    ensureBusiness().then(e.detail.resolve, e.detail.reject);
  });
  const check = async () => {
    if (checking || document.hidden || !current) return;
    checking = true;
    status("checking");
    try {
      const next = await getManifest();
      if (next.buildId === current.buildId) {
        status("ready", "已是当前发布版本");
        return;
      }
      if (
        next.files.app.sha256 !== current.files.app.sha256 ||
        next.files.css.sha256 !== current.files.css.sha256
      ) {
        status("new-version", "新版页面已发布，请先保存填写，再刷新使用");
        window.dispatchEvent(
          new CustomEvent("delivery-online-notice", {
            detail: "新版页面已发布，请先保存填写，再刷新使用。",
          }),
        );
        return;
      }
      const [d, b, digest, workspace] = await Promise.all([
        load(next.files.data),
        businessLoaded ? load(next.files.business) : Promise.resolve(null),
        next.files.digest ? load(next.files.digest) : Promise.resolve(null),
        next.files.workspace ? load(next.files.workspace) : Promise.resolve(null),
      ]);
      const parsed = JSON.parse(d);
      if (parsed.meta?.current_data_cutoff < current.dataThrough) throw Error("线上日期回退");
      if (digest && JSON.parse(digest).dataThrough !== parsed.meta?.current_data_cutoff)
        throw Error("测试简报与经营数据日期不一致");
      current = next;
      window.dispatchEvent(
        new CustomEvent("delivery-online-data", {
          detail: { data: parsed, ...(b ? { business: JSON.parse(b) } : {}), ...(workspace ? {workspace:JSON.parse(workspace)} : {}) },
        }),
      );
      inject("delivery-snapshot", d, "application/json");
      if(workspace)inject("delivery-workspace",workspace,"application/json");
      if (b) inject("delivery-business", b, "application/json");
      if (digest) {
        inject("delivery-test-digest", digest, "application/json");
        window.dispatchEvent(new CustomEvent("delivery-test-digest"));
      }
      status("ready", "已载入最新数据，本机填写保持不变");
    } catch {
      status("error", "本次检查未完成，继续使用已经载入的数据。可以重试。");
    } finally {
      checking = false;
    }
  };
  try {
    current = await getManifest();
    // Cost/source bundles load only when profit, data management, or offline save needs them.
    const [data, css, app, workspace, digest] = await Promise.all([
      load(current.files.data),
      load(current.files.css),
      load(current.files.app),
      current.files.workspace ? load(current.files.workspace) : Promise.resolve(null),
      current.files.digest ? load(current.files.digest) : Promise.resolve(null),
    ]);
    if (digest && JSON.parse(digest).dataThrough !== JSON.parse(data).meta?.current_data_cutoff)
      throw Error("测试简报与经营数据日期不一致");
    inject("delivery-snapshot", data, "application/json");
    inject("delivery-online-style", css, "style");
    if (workspace) inject("delivery-workspace", workspace, "application/json");
    if (digest) inject("delivery-test-digest", digest, "application/json");
    status("ready");
    const script = document.createElement("script");
    script.id = "delivery-app";
    script.textContent = app;
    document.body.appendChild(script);
    setInterval(check, 60000);
    document.addEventListener("visibilitychange", check);
    window.addEventListener("delivery-check-now", check);
  } catch (e) {
    const root = document.getElementById("root");
    root.textContent =
      (e instanceof Error ? e.message : "网页暂时未加载成功") +
      "。请刷新重试，或打开已保存的HTML。";
  }
})();
