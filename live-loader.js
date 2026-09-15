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
  const progress = new Map();
  const downloaded = new Map();
  const boot = (message) => window.deliveryBootProgress?.(message);
  const dataMeta = value => value?.format === 'zmp-columns-v1' ? value.base?.meta : value?.meta;
  const deadline = (job, ms, message) => {
    let timer;
    return Promise.race([job, new Promise((_,reject) => { timer=setTimeout(()=>reject(Error(message)),ms); })]).finally(()=>clearTimeout(timer));
  };
  async function bytes(part, label = '', noStore = false) {
    const u = new URL(part.file, manifestURL);
    if (u.origin !== location.origin) throw Error('数据文件来源不一致');
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const job = (async () => {
      const response = await deadline(fetch(u, { ...(noStore ? {cache:'no-store'} : {}), ...(controller ? {signal:controller.signal} : {}) }),30000,'网络连接超时，请重新加载');
      if (!response.ok) throw Error('数据连接未成功，请重新加载');
      if (!response.body?.getReader) return response.arrayBuffer();
      const reader = response.body.getReader(), chunks = [];
      let length = 0;
      try {
        while (true) {
          const chunk = await deadline(reader.read(), 30000, '网络连接中断，请重新加载');
          if (chunk.done) break;
          chunks.push(chunk.value); length += chunk.value.byteLength;
          if (label) {
            progress.set(part.file, {read:length,total:part.bytes || length});
            const values=[...progress.values()];
            const read=values.reduce((s,x)=>s+x.read,0),total=values.reduce((s,x)=>s+x.total,0);
            boot(`正在载入${label} · ${(read/1048576).toFixed(1)} / ${(total/1048576).toFixed(1)} MB`);
          }
        }
      } finally { reader.releaseLock(); }
      const out = new Uint8Array(length); let offset=0;
      for(const chunk of chunks){out.set(chunk,offset);offset+=chunk.byteLength;}
      return out.buffer;
    })();
    try {
      const body = await deadline(job,180000,'本次下载超时，请重试或换用系统浏览器');
      if (part.sha256) {
        if (!crypto.subtle) throw Error('当前浏览器不支持数据校验，请用系统浏览器打开');
        const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',body)),x=>x.toString(16).padStart(2,'0')).join('');
        if(hash!==part.sha256)throw Error('数据文件校验未通过');
      }
      return body;
    } finally { controller?.abort(); }
  }
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
    return JSON.parse(await deadline(bytes({file:manifestURL.href},'',true).then(b=>new TextDecoder().decode(b)),30000,'连接最新版本超时，请重新加载'));
  }
  async function load(part, label = '') {
    if (downloaded.has(part.sha256)) return downloaded.get(part.sha256);
    const job=(async()=>{
      if (typeof DecompressionStream === 'function' && typeof Blob.prototype.stream === 'function') {
        const raw=await bytes(part,label);
        try { return await deadline(new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'))).text(),30000,'浏览器解压未完成'); }
        catch { /* Some embedded browsers expose an incomplete implementation. */ }
      }
      if (!part.fallback) throw Error('当前浏览器不能读取压缩数据，请用系统浏览器打开');
      return new TextDecoder().decode(await bytes(part.fallback,label));
    })();
    downloaded.set(part.sha256,job);
    try { return await job; } catch(e) { downloaded.delete(part.sha256);throw e; }
  }
  // Keep portable HTML and reports self-contained without downloading every screenshot at startup.
  window.deliveryPortableText = async text => {
    for (const im of current?.images || []) {
      const token='./'+im.file;
      if (!text.includes(token)) continue;
      const raw=new Uint8Array(await bytes(im));
      let binary='';for(let i=0;i<raw.length;i+=32768)binary+=String.fromCharCode(...raw.subarray(i,i+32768));
      text=text.split(token).join(`data:${im.mime};base64,${btoa(binary)}`);
    }
    return text;
  };
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
      if (dataMeta(parsed)?.current_data_cutoff < current.dataThrough) throw Error("线上日期回退");
      if (digest && JSON.parse(digest).dataThrough !== dataMeta(parsed)?.current_data_cutoff)
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
    for (const key of ['data','css','app','workspace','digest']) if(current.files[key]) {
      const part=typeof DecompressionStream==='function'?current.files[key]:(current.files[key].fallback||current.files[key]);
      progress.set(part.file,{read:0,total:part.bytes||0});
    }
    // Cost/source bundles load only when profit, data management, or offline save needs them.
    const [data, css, app, workspace, digest] = await Promise.all([
      load(current.files.data,'经营明细'),
      load(current.files.css,'页面样式'),
      load(current.files.app,'看板程序'),
      current.files.workspace ? load(current.files.workspace,'测试记录') : Promise.resolve(null),
      current.files.digest ? load(current.files.digest,'测试简报') : Promise.resolve(null),
    ]);
    if (digest && JSON.parse(digest).dataThrough !== dataMeta(JSON.parse(data))?.current_data_cutoff)
      throw Error("测试简报与经营数据日期不一致");
    inject("delivery-snapshot", data, "application/json");
    inject("delivery-online-style", css, "style");
    if (workspace) inject("delivery-workspace", workspace, "application/json");
    if (digest) inject("delivery-test-digest", digest, "application/json");
    status("ready");
    boot('数据校验完成，正在打开看板…');
    const script = document.createElement("script");
    script.id = "delivery-app";
    script.textContent = app;
    document.body.appendChild(script);
    setInterval(check, 60000);
    document.addEventListener("visibilitychange", check);
    window.addEventListener("delivery-check-now", check);
  } catch (e) {
    if (window.deliveryBootError) { window.deliveryBootError((e instanceof Error?e.message:'网页暂时未加载成功')+'。已有填写不会因此清空。');return; }
    const root = document.getElementById("root");
    root.textContent =
      (e instanceof Error ? e.message : "网页暂时未加载成功") +
      "。请刷新重试，或打开已保存的HTML。";
  }
})();
