(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const state = {
    projects: [], engines: [], runtime: {}, token: "", maxUploadBytes: 0,
    selectedId: null, current: null, generation: 0, initialized: false,
    pollTimer: null, pollController: null, pollErrors: 0, refreshTimer: null,
    sourceController: null, sourceVersion: 0, sourcePath: null,
    pdfKey: null, sidebarSignature: "", fileSignature: "",
    pendingCompile: new Set(), pendingSettings: new Set(), pendingReveal: new Set(),
    optimisticSettings: new Map(), versions: new Map(), uploading: false,
    connecting: false, refreshing: false, readSerial: 0, appliedReads: new Map(),
  };

  function icon(name, extraClass = "") {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", `icon ${extraClass}`.trim());
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#i-${name}`);
    svg.append(use);
    return svg;
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function toast(message, isError = false) {
    const node = element("div", `toast${isError ? " error" : ""}`);
    node.append(icon(isError ? "alert" : "check"), element("span", "", message));
    const close = element("button", "icon-button");
    close.type = "button";
    close.setAttribute("aria-label", "关闭提示");
    close.append(icon("close"));
    close.addEventListener("click", () => node.remove());
    node.append(close);
    $("toast-region").append(node);
    while ($("toast-region").children.length > 3) $("toast-region").firstElementChild.remove();
    window.setTimeout(() => node.remove(), isError ? 12000 : 6000);
  }

  async function request(path, options = {}) {
    const method = options.method || "GET";
    const headers = { Accept: options.raw ? "text/plain" : "application/json", ...options.headers };
    let body = options.body;
    if (method !== "GET" && method !== "HEAD") headers["X-Latex-Token"] = state.token;
    if (body !== undefined && !(body instanceof ArrayBuffer) && !(body instanceof Blob)) {
      body = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
    }
    let response;
    try {
      response = await fetch(path, {
        method, headers, body, signal: options.signal,
        credentials: "same-origin", cache: "no-store",
      });
    } catch (error) {
      if (error.name === "AbortError") throw error;
      throw new Error("无法连接本地服务，请确认服务正在运行。");
    }
    if (!response.ok) {
      let message = `请求失败（${response.status}）`;
      try {
        const result = await response.json();
        if (typeof result.error === "string") message = result.error;
      } catch (_) { /* Keep a useful HTTP error when the response is not JSON. */ }
      throw new Error(message);
    }
    if (options.raw) return response.text();
    try { return await response.json(); }
    catch (_) { throw new Error("本地服务返回了无效响应，请重新连接。"); }
  }

  function projectPath(id) { return `/api/projects/${encodeURIComponent(id)}`; }
  function version(id) { return state.versions.get(id) || 0; }
  function bumpVersion(id) { state.versions.set(id, version(id) + 1); }
  function isNewRead(id, serial) { return serial >= (state.appliedReads.get(id) || 0); }
  function isCurrent(id, generation) { return id === state.selectedId && generation === state.generation; }
  function hasMutation(id) { return state.pendingCompile.has(id) || state.pendingSettings.has(id); }
  function statusOf(project) {
    if (state.pendingCompile.has(project.id)) return "queued";
    return project.build?.status || "idle";
  }
  function isBusy(project) { return ["queued", "running"].includes(statusOf(project)); }
  function engineAvailable(id) { return state.engines.some((engine) => engine.id === id && engine.available); }
  function engineName(id) { return state.engines.find((engine) => engine.id === id)?.name || id || "LaTeX"; }
  function formatBytes(bytes) {
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes || 0} B`;
  }
  function formatDuration(seconds) {
    if (!Number.isFinite(seconds)) return "";
    if (seconds < 60) return `${Math.max(0, seconds).toFixed(seconds < 10 ? 1 : 0)} 秒`;
    return `${Math.floor(seconds / 60)} 分 ${Math.floor(seconds % 60)} 秒`;
  }
  function formatTime(timestamp) {
    if (!timestamp) return "";
    const date = new Date(timestamp * 1000);
    if (Number.isNaN(date.getTime())) return "";
    const sameDay = date.toDateString() === new Date().toDateString();
    return date.toLocaleString("zh-CN", {
      ...(sameDay ? {} : { month: "2-digit", day: "2-digit" }),
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
  }

  function upsertProject(project) {
    if (!project || !project.id) return;
    const index = state.projects.findIndex((item) => item.id === project.id);
    if (index === -1) state.projects.unshift(project);
    else state.projects[index] = project;
  }

  function applyProject(project) {
    upsertProject(project);
    if (project.id === state.selectedId) {
      state.current = project;
      renderProject();
    }
    renderSidebar();
  }

  function renderSidebar() {
    const signature = JSON.stringify(state.projects.map((p) => [
      p.id, p.name, p.engine, statusOf(p), p.build?.source_changed, p.id === state.selectedId,
    ]));
    if (signature === state.sidebarSignature) return;
    state.sidebarSignature = signature;
    $("project-count").textContent = state.projects.length;
    $("no-projects").hidden = state.projects.length > 0;
    const fragment = document.createDocumentFragment();
    for (const project of state.projects) {
      const selected = project.id === state.selectedId;
      const button = element("button", `project-item${selected ? " active" : ""}`);
      button.type = "button";
      button.title = project.name;
      if (selected) button.setAttribute("aria-current", "page");
      const content = element("span", "project-item-body");
      content.append(element("span", "project-item-name", project.name));
      const status = statusOf(project);
      const labels = { idle: "尚未编译", queued: "等待编译", running: "正在编译", success: "已编译", error: "编译失败" };
      const changed = project.build?.source_changed && !isBusy(project) && status !== "error"
        && (status !== "idle" || project.build?.pdf_url);
      const detail = element("span", "project-item-detail");
      const tone = changed ? "warning" : ({ idle: "neutral", queued: "running", running: "running", error: "error", success: "success" }[status] || "neutral");
      detail.append(element("span", `status-dot ${tone}`), element("span", "", `${engineName(project.engine)} · ${changed ? "待更新" : labels[status] || labels.idle}`));
      content.append(detail);
      button.append(icon("paper"), content);
      button.addEventListener("click", () => selectProject(project.id));
      fragment.append(button);
    }
    $("project-list").replaceChildren(fragment);
  }

  function renderRuntime() {
    $("runtime-dot").className = `status-dot ${state.runtime.ready ? "success" : "warning"}`;
    $("runtime-label").textContent = state.runtime.ready ? "编译环境已就绪" : "编译环境准备中";
    $("runtime-label").title = [state.runtime.distribution, state.runtime.latexmk].filter(Boolean).join(" · ");
  }

  function setSelectOptions(select, options, selected) {
    const signature = JSON.stringify(options);
    if (select.dataset.options !== signature) {
      select.replaceChildren(...options.map((item) => {
        const option = document.createElement("option");
        option.value = item.value;
        option.textContent = item.label;
        option.disabled = Boolean(item.disabled);
        return option;
      }));
      select.dataset.options = signature;
    }
    select.value = selected || "";
  }

  function renderProject() {
    const project = state.current;
    if (!project) return;
    const settings = { ...project, ...state.optimisticSettings.get(project.id) };
    const busy = isBusy(project);
    const changing = state.pendingSettings.has(project.id);
    $("project-title").textContent = project.name;
    $("project-title").title = project.name;
    document.title = `${project.name} — Paper Studio`;
    $("reveal-button").title = `在 Finder 中打开 ${project.root || "项目源码文件夹"}`;
    $("reveal-button").disabled = state.pendingReveal.has(project.id);

    const texFiles = [...(project.tex_files || [])];
    if (settings.main_file && !texFiles.includes(settings.main_file)) texFiles.unshift(settings.main_file);
    const mainOptions = texFiles.map((path) => ({ value: path, label: path }));
    if (!settings.main_file) mainOptions.unshift({ value: "", label: texFiles.length ? "请选择主文档" : "没有找到 .tex 文件", disabled: true });
    setSelectOptions($("main-file-select"), mainOptions, settings.main_file);
    $("main-file-select").title = settings.main_file || "选择包含 documentclass 的主文档";
    $("main-file-select").disabled = changing || busy || !texFiles.length;
    const engines = state.engines.map((engine) => ({ value: engine.id, label: `${engine.name}${engine.available ? "" : "（未安装）"}`, disabled: !engine.available }));
    if (settings.engine && !engines.some((engine) => engine.value === settings.engine)) {
      engines.push({ value: settings.engine, label: `${settings.engine}（未安装）`, disabled: true });
    }
    setSelectOptions($("engine-select"), engines, settings.engine);
    $("engine-select").disabled = changing || busy;
    $("watch-toggle").checked = Boolean(settings.watch);
    $("watch-toggle").disabled = changing || state.pendingCompile.has(project.id);

    const unavailable = !engineAvailable(project.engine);
    $("runtime-warning").hidden = Boolean(state.runtime.ready && !unavailable);
    $("runtime-warning").querySelector("span").textContent = !state.runtime.ready
      ? "TeX 编译环境尚未就绪。准备完成后即可编译。"
      : `所选的 ${engineName(project.engine)} 暂未安装，请选择已就绪的编译引擎。`;
    $("source-warning").hidden = !project.source_error;
    $("source-warning-text").textContent = project.source_error ? `无法读取项目源码：${project.source_error}` : "";
    $("compile-button").disabled = busy || changing || !state.runtime.ready || !project.main_file || unavailable || Boolean(project.source_error);
    $("compile-label").textContent = busy ? (statusOf(project) === "queued" ? "等待编译…" : "编译中…") : "编译 PDF";
    $("compile-icon").classList.toggle("spinning", busy);
    $("compile-icon").querySelector("use").setAttribute("href", busy ? "#i-spinner" : "#i-play");
    $("compile-button").setAttribute("aria-busy", String(busy));

    renderBuild(project);
    renderPdf(project);
    $("file-count").textContent = `${(project.files || []).length} 个文件`;
    $("full-log").href = `${projectPath(project.id)}/log`;
    if ($("source-details").open) renderFiles();
  }

  function renderBuild(project) {
    const build = project.build || {};
    const status = statusOf(project);
    const warnings = Array.isArray(build.warnings) ? build.warnings.length : 0;
    const changed = build.source_changed && !isBusy(project) && status !== "error"
      && (status !== "idle" || build.pdf_url);
    const labels = { idle: "尚未编译", queued: "等待编译", running: "正在编译", success: warnings ? `编译完成 · ${warnings} 条提示` : "编译完成", error: "编译失败" };
    $("build-label").textContent = changed ? "源文件已更新，待编译" : (labels[status] || labels.idle);
    const tone = changed ? "warning" : ({ idle: "neutral", queued: "running", running: "running", success: "success", error: "error" }[status] || "neutral");
    $("build-dot").className = `status-dot ${tone}`;
    updateDuration();
    $("build-error").hidden = status !== "error";
    $("build-error-text").textContent = build.error || "编译没有成功，请展开日志查看具体原因。";
    $("log-summary").textContent = isBusy(project) ? "实时更新中" : warnings ? `${warnings} 条提示` : (labels[status] || labels.idle);
    $("log-panel-status").textContent = project.main_file ? `${engineName(project.engine)} · ${project.main_file}` : "编译输出";
    const log = build.log_tail || (isBusy(project) ? "正在启动编译，请稍候…" : "编译后，这里会显示日志。");
    const pre = $("build-log");
    const selection = window.getSelection();
    const selectingLog = selection && !selection.isCollapsed
      && (pre.contains(selection.anchorNode) || pre.contains(selection.focusNode));
    if (pre.textContent !== log && !selectingLog) {
      const atBottom = pre.scrollHeight - pre.clientHeight - pre.scrollTop < 60;
      pre.textContent = log;
      if (atBottom) pre.scrollTop = pre.scrollHeight;
    }
  }

  function updateDuration() {
    const project = state.current;
    if (!project) return;
    const build = project.build || {};
    let duration = "";
    if (isBusy(project)) {
      if (statusOf(project) === "running" && build.started_at) duration = formatDuration((Date.now() / 1000) - build.started_at);
    } else if (build.duration !== null && build.duration !== undefined) duration = formatDuration(build.duration);
    $("build-duration").textContent = duration ? `· ${duration}` : "";
  }

  function renderPdf(project) {
    const build = project.build || {};
    const busy = isBusy(project);
    const status = statusOf(project);
    const pdfUrl = build.pdf_url;
    $("pdf-frame").hidden = !pdfUrl;
    $("empty-preview").hidden = Boolean(pdfUrl);
    $("open-pdf").hidden = !pdfUrl;
    $("download-pdf").hidden = !pdfUrl;
    $("pdf-updated").textContent = pdfUrl && build.pdf_built_at ? `更新于 ${formatTime(build.pdf_built_at)}` : "";
    const badge = $("preview-badge");
    badge.hidden = !(pdfUrl && (busy || status === "error" || build.source_changed));
    badge.textContent = busy ? "上次成功 · 正在更新" : status === "error" ? "上次成功的 PDF" : "源码有更新";
    if (pdfUrl) {
      const url = new URL(pdfUrl, window.location.href);
      // PDF destinations are always served by this local application.
      if (url.origin !== window.location.origin) return;
      url.searchParams.set("v", String(build.pdf_built_at || 0));
      const key = `${project.id}:${url.href}`;
      if (state.pdfKey !== key) {
        state.pdfKey = key;
        $("pdf-frame").src = `${url.href}#view=FitH`;
        $("pdf-frame").title = `${project.name} 的 PDF 预览`;
      }
      $("open-pdf").href = url.href;
      const download = new URL(url.href);
      download.searchParams.set("download", "1");
      $("download-pdf").href = download.href;
      $("download-pdf").download = `${project.name}.pdf`;
    } else {
      if (state.pdfKey !== null) {
        state.pdfKey = null;
        $("pdf-frame").removeAttribute("src");
      }
      $("open-pdf").removeAttribute("href");
      $("download-pdf").removeAttribute("href");
      $("empty-preview-title").textContent = busy ? "正在生成你的 PDF" : status === "error" ? "这次编译遇到了一点问题" : "预览即将呈现";
      $("empty-preview-description").textContent = busy
        ? "首次编译可能需要一点时间，日志会实时更新。"
        : status === "error" ? "展开下方的编译日志，查看需要修正的地方。"
          : !project.main_file ? "请先在上方选择主文档。" : "选择主文档，点击「编译 PDF」。";
    }
  }

  function renderFiles() {
    const project = state.current;
    if (!project) return;
    const filter = $("file-filter").value.trim().toLocaleLowerCase();
    const files = (project.files || []).filter((file) => file.path.toLocaleLowerCase().includes(filter));
    const signature = JSON.stringify([project.id, files.map((file) => [file.path, file.size]), state.sourcePath]);
    if (signature === state.fileSignature) return;
    state.fileSignature = signature;
    const fragment = document.createDocumentFragment();
    for (const file of files) {
      const button = element("button", `file-button${file.path === state.sourcePath ? " active" : ""}`);
      button.type = "button";
      button.title = `${file.path} · ${formatBytes(file.size)}`;
      button.setAttribute("aria-pressed", String(file.path === state.sourcePath));
      button.append(icon(isTextSource(file.path) ? "code" : "paper"), element("span", "file-name", file.path));
      button.addEventListener("click", () => openSource(file.path));
      const item = element("div", "file-item");
      item.setAttribute("role", "listitem");
      item.append(button);
      fragment.append(item);
    }
    if (!files.length) fragment.append(element("p", "file-empty", filter ? "没有匹配的文件" : "项目中尚无文件"));
    $("file-list").replaceChildren(fragment);
  }

  function isTextSource(path) {
    return /\.(tex|sty|cls|bib|bst|txt|md|cfg|def|ltx|bbx|cbx|lbx|ist|clo|log|json|ya?ml|toml|csv|tsv|xml|html|css|js|py|r|sh|mk|ins|dtx|eps|ps|svg|aux|bbl|blg|out|toc|lof|lot|fdb_latexmk|fls)$/i.test(path)
      || /(^|\/)(latexmkrc|\.latexmkrc|makefile|readme|license)$/i.test(path);
  }

  async function openSource(path) {
    const project = state.current;
    if (!project || !path) return;
    state.sourceController?.abort();
    const controller = new AbortController();
    state.sourceController = controller;
    const requestVersion = ++state.sourceVersion;
    const generation = state.generation;
    const id = project.id;
    state.sourcePath = path;
    $("source-path").textContent = path;
    $("source-path").title = path;
    $("source-refresh").disabled = true;
    renderFiles();
    if (!isTextSource(path)) {
      $("source-content").textContent = `此文件无法作为文本预览。\n\n${path}\n\n点击「打开源码文件夹」，使用本机应用查看。`;
      return;
    }
    $("source-content").textContent = "正在读取源文件…";
    try {
      const content = await request(`${projectPath(id)}/source?path=${encodeURIComponent(path)}`, { raw: true, signal: controller.signal });
      if (!isCurrent(id, generation) || requestVersion !== state.sourceVersion) return;
      $("source-content").textContent = content.includes("\0") ? "此文件包含二进制内容，请在源码文件夹中查看。" : content || "（空文件）";
      $("source-content").scrollTop = 0;
      $("source-content").scrollLeft = 0;
    } catch (error) {
      if (error.name !== "AbortError" && isCurrent(id, generation) && requestVersion === state.sourceVersion) {
        $("source-content").textContent = `无法读取文件：${error.message}`;
      }
    } finally {
      if (isCurrent(id, generation) && requestVersion === state.sourceVersion) $("source-refresh").disabled = false;
    }
  }

  function selectProject(id) {
    const project = state.projects.find((item) => item.id === id);
    if (!project || (id === state.selectedId && state.current)) return;
    state.generation += 1;
    state.pollController?.abort();
    state.sourceController?.abort();
    clearTimeout(state.pollTimer);
    state.selectedId = id;
    state.current = project;
    state.sourcePath = null;
    state.sourceVersion += 1;
    state.fileSignature = "";
    state.pollErrors = 0;
    $("file-filter").value = "";
    $("source-path").textContent = "选择一个文件";
    $("source-content").textContent = "在左侧选择文件，即可查看源码。";
    $("source-refresh").disabled = true;
    $("build-log").textContent = "";
    $("welcome-view").hidden = true;
    $("loading-view").hidden = true;
    $("connection-error").hidden = true;
    $("project-view").hidden = false;
    const url = new URL(window.location.href);
    url.searchParams.set("project", id);
    history.replaceState(null, "", url);
    renderSidebar();
    renderProject();
    if ($("source-details").open) selectDefaultSource();
    schedulePoll(0);
  }

  function selectDefaultSource() {
    if (!state.current || state.sourcePath) return;
    const files = state.current.files || [];
    const first = files.find((file) => file.path === state.current.main_file)
      || files.find((file) => isTextSource(file.path)) || files[0];
    if (first) openSource(first.path);
  }

  function schedulePoll(delay) {
    clearTimeout(state.pollTimer);
    state.pollTimer = window.setTimeout(pollProject, delay);
  }

  async function pollProject() {
    const id = state.selectedId;
    if (!id) return;
    if (hasMutation(id)) { schedulePoll(700); return; }
    const generation = state.generation;
    const requestVersion = version(id);
    const readSerial = ++state.readSerial;
    const controller = new AbortController();
    state.pollController?.abort();
    state.pollController = controller;
    try {
      const { project } = await request(projectPath(id), { signal: controller.signal });
      if (!isCurrent(id, generation) || requestVersion !== version(id) || !isNewRead(id, readSerial)) return;
      state.appliedReads.set(id, readSerial);
      if (state.pollErrors > 1) toast("已重新连接本地编译服务。");
      state.pollErrors = 0;
      renderRuntime();
      applyProject(project);
    } catch (error) {
      if (error.name !== "AbortError" && isCurrent(id, generation)) {
        state.pollErrors += 1;
        if (state.pollErrors === 2) {
          toast("与本地服务的连接中断，正在重新连接…", true);
          $("runtime-dot").className = "status-dot warning";
          $("runtime-label").textContent = "正在重新连接";
        }
      }
    } finally {
      if (isCurrent(id, generation)) schedulePoll(document.hidden ? 5000 : state.pollErrors ? 4000 : state.current && isBusy(state.current) ? 1000 : 2500);
    }
  }

  async function compileProject(id = state.selectedId) {
    const project = state.projects.find((item) => item.id === id);
    if (!project || isBusy(project) || hasMutation(id)) return;
    if (!state.runtime.ready || !engineAvailable(project.engine) || !project.main_file || project.source_error) return;
    state.pendingCompile.add(id);
    bumpVersion(id);
    if (id === state.selectedId) { state.pollController?.abort(); renderProject(); }
    renderSidebar();
    try {
      const result = await request(`${projectPath(id)}/compile`, { method: "POST", body: {} });
      applyProject(result.project);
    } catch (error) {
      toast(`无法开始编译：${error.message}`, true);
    } finally {
      state.pendingCompile.delete(id);
      bumpVersion(id);
      if (id === state.selectedId) { renderProject(); schedulePoll(300); }
      renderSidebar();
    }
  }

  async function updateSettings(changes) {
    const id = state.selectedId;
    if (!id || hasMutation(id)) { if (state.current) renderProject(); return; }
    state.pendingSettings.add(id);
    state.optimisticSettings.set(id, changes);
    bumpVersion(id);
    state.pollController?.abort();
    renderProject();
    try {
      const { project } = await request(projectPath(id), { method: "PATCH", body: changes });
      applyProject(project);
    } catch (error) {
      toast(`设置未保存：${error.message}`, true);
    } finally {
      state.pendingSettings.delete(id);
      state.optimisticSettings.delete(id);
      bumpVersion(id);
      if (id === state.selectedId) { renderProject(); schedulePoll(300); }
      renderSidebar();
    }
  }

  async function revealProject() {
    const id = state.selectedId;
    if (!id || state.pendingReveal.has(id)) return;
    state.pendingReveal.add(id);
    renderProject();
    try { await request(`${projectPath(id)}/reveal`, { method: "POST", body: {} }); }
    catch (error) { toast(`无法打开源码文件夹：${error.message}`, true); }
    finally {
      state.pendingReveal.delete(id);
      if (id === state.selectedId) renderProject();
    }
  }

  async function importFile(file) {
    if (!file || state.uploading) return;
    if (!state.initialized) { toast("请等待本地服务连接成功后再导入。", true); return; }
    if (!/\.zip$/i.test(file.name)) { toast("请选择 Overleaf 导出的 ZIP 文件。", true); return; }
    if (!file.size) { toast("这个 ZIP 文件是空的，请检查后重新导入。", true); return; }
    if (state.maxUploadBytes && file.size > state.maxUploadBytes) {
      toast(`ZIP 文件超过 ${formatBytes(state.maxUploadBytes)} 的上传限制。`, true);
      return;
    }
    state.uploading = true;
    $("import-button").disabled = true;
    $("welcome-import").disabled = true;
    $("import-label").textContent = "正在导入…";
    const importIcon = $("import-button").querySelector("svg");
    importIcon.classList.add("spinning");
    importIcon.querySelector("use").setAttribute("href", "#i-spinner");
    try {
      const { project } = await request(`/api/projects?name=${encodeURIComponent(file.name)}`, {
        method: "POST", body: await file.arrayBuffer(), headers: { "Content-Type": "application/zip" },
      });
      upsertProject(project);
      selectProject(project.id);
      toast("项目已导入，源文件已保存到本机。");
      if (state.runtime.ready && engineAvailable(project.engine) && project.main_file) await compileProject(project.id);
    } catch (error) {
      toast(`导入失败：${error.message}`, true);
    } finally {
      state.uploading = false;
      $("import-button").disabled = false;
      $("welcome-import").disabled = false;
      $("import-label").textContent = "导入 Overleaf 项目";
      importIcon.classList.remove("spinning");
      importIcon.querySelector("use").setAttribute("href", "#i-plus");
      $("zip-input").value = "";
    }
  }

  async function refreshState() {
    if (!state.initialized || state.refreshing || document.hidden) return;
    state.refreshing = true;
    const versions = new Map(state.versions);
    const readSerial = ++state.readSerial;
    try {
      const data = await request("/api/state");
      state.token = data.csrf_token;
      state.runtime = data.runtime || {};
      state.engines = data.engines || [];
      state.maxUploadBytes = data.max_upload_bytes || 0;
      for (const project of data.projects || []) {
        if (!hasMutation(project.id) && version(project.id) === (versions.get(project.id) || 0) && isNewRead(project.id, readSerial)) {
          state.appliedReads.set(project.id, readSerial);
          upsertProject(project);
          if (project.id === state.selectedId) state.current = project;
        }
      }
      renderRuntime();
      renderSidebar();
      if (state.current) renderProject();
      else if (state.projects.length) selectProject(state.projects[0].id);
    } catch (_) { /* Project polling reports connection errors without repeated notifications. */ }
    finally { state.refreshing = false; }
  }

  async function initialize() {
    if (state.connecting) return;
    state.connecting = true;
    $("loading-view").hidden = false;
    $("connection-error").hidden = true;
    $("retry-button").disabled = true;
    try {
      const data = await request("/api/state");
      state.projects = data.projects || [];
      state.engines = data.engines || [];
      state.runtime = data.runtime || {};
      state.token = data.csrf_token;
      state.maxUploadBytes = data.max_upload_bytes || 0;
      state.initialized = true;
      renderRuntime();
      renderSidebar();
      $("loading-view").hidden = true;
      if (state.projects.length) {
        const requestedId = new URLSearchParams(window.location.search).get("project");
        const project = state.projects.find((item) => item.id === requestedId) || state.projects[0];
        selectProject(project.id);
      } else $("welcome-view").hidden = false;
      clearInterval(state.refreshTimer);
      state.refreshTimer = window.setInterval(refreshState, 15000);
    } catch (error) {
      $("loading-view").hidden = true;
      $("connection-error").hidden = false;
      $("connection-error-text").textContent = error.message;
      $("runtime-dot").className = "status-dot error";
      $("runtime-label").textContent = "服务未连接";
    } finally {
      state.connecting = false;
      $("retry-button").disabled = false;
    }
  }

  $("import-button").addEventListener("click", () => $("zip-input").click());
  $("welcome-import").addEventListener("click", () => $("zip-input").click());
  $("zip-input").addEventListener("change", (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    importFile(file);
  });
  $("compile-button").addEventListener("click", () => compileProject());
  $("main-file-select").addEventListener("change", (event) => updateSettings({ main_file: event.target.value }));
  $("engine-select").addEventListener("change", (event) => updateSettings({ engine: event.target.value }));
  $("watch-toggle").addEventListener("change", (event) => updateSettings({ watch: event.target.checked }));
  $("reveal-button").addEventListener("click", revealProject);
  $("retry-button").addEventListener("click", initialize);
  $("file-filter").addEventListener("input", renderFiles);
  $("source-refresh").addEventListener("click", () => openSource(state.sourcePath));
  $("source-details").addEventListener("toggle", () => {
    if ($("source-details").open) { renderFiles(); selectDefaultSource(); }
  });
  $("log-details").addEventListener("toggle", () => {
    if ($("log-details").open) $("build-log").scrollTop = $("build-log").scrollHeight;
  });
  $("show-log-button").addEventListener("click", () => {
    $("log-details").open = true;
    $("log-details").scrollIntoView({ block: "nearest" });
  });
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      if (state.current && !$("compile-button").disabled) compileProject();
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.selectedId) schedulePoll(0);
  });

  let dragDepth = 0;
  function isFileDrag(event) { return event.dataTransfer && Array.from(event.dataTransfer.types).includes("Files"); }
  function hideDrop() { dragDepth = 0; $("drop-overlay").hidden = true; }
  document.addEventListener("dragenter", (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragDepth += 1;
    if (!state.uploading) $("drop-overlay").hidden = false;
  });
  document.addEventListener("dragover", (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = state.uploading ? "none" : "copy";
  });
  document.addEventListener("dragleave", (event) => {
    if (!isFileDrag(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) hideDrop();
  });
  document.addEventListener("drop", (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    hideDrop();
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 1) { toast("请一次导入一个 ZIP 项目。", true); return; }
    if (state.uploading) { toast("当前项目正在导入，请稍候。"); return; }
    importFile(files[0]);
  });
  window.addEventListener("dragend", hideDrop);
  window.addEventListener("blur", hideDrop);
  window.setInterval(updateDuration, 500);
  initialize();
})();
