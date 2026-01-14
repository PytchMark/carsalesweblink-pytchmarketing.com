// =============================
    // API CONTRACT (expected)
    // =============================
    // POST /api/admin/login                  { username, password } -> { ok:true, token }
    // GET  /api/admin/dealers                (auth) -> { ok:true, dealers:[...] }
    // POST /api/admin/dealers                (auth) -> { ok:true, dealer, passcode? }
    // POST /api/admin/reset-passcode         (auth) -> { ok:true, dealerId, passcode }
    // GET  /api/admin/inventory              (auth) -> { ok:true, vehicles:[...] }
    // GET  /api/admin/requests               (auth) -> { ok:true, requests:[...] }
    //
    // Public:
    // GET  /api/public/config                -> { ok:true, cloudinary:{ cloudName, uploadPreset, baseFolder } }

    const API = {
      login: () => "/api/admin/login",
      dealers: () => "/api/admin/dealers",
      resetPass: () => "/api/admin/reset-passcode",
      inventory: () => "/api/admin/inventory",
      requests: () => "/api/admin/requests",
      dealerVehicles: (dealerId) => `/api/admin/dealer/${encodeURIComponent(dealerId)}/vehicles`,
      dealerLeads: (dealerId) => `/api/admin/dealer/${encodeURIComponent(dealerId)}/leads`,
      dealerLeadStatus: (dealerId) => `/api/admin/dealer/${encodeURIComponent(dealerId)}/leads/status`,
      publicConfig: () => "/api/public/config",
      settings: () => "/api/admin/settings",
    };

    const el = (id) => document.getElementById(id);

    const ui = {
      loginView: el("loginView"),
      dashView: el("dashView"),
      username: el("username"),
      password: el("password"),
      btnLogin: el("btnLogin"),
      btnDemo: el("btnDemo"),
      loginStatus: el("loginStatus"),

      whoami: el("whoami"),
      apiDot: el("apiDot"),
      apiStatus: el("apiStatus"),
      btnRefresh: el("btnRefresh"),
      btnLogout: el("btnLogout"),

      tabDealers: el("tabDealers"),
      tabInventory: el("tabInventory"),
      tabRequests: el("tabRequests"),
      tabDealerView: el("tabDealerView"),
      tabSettings: el("tabSettings"),

      hint: el("hint"),

      q: el("q"),
      statusFilterWrap: el("statusFilterWrap"),
      statusFilter: el("statusFilter"),

      tableTitle: el("tableTitle"),
      theadRow: el("theadRow"),
      tbody: el("tbody"),
      count: el("count"),
      lastUpdated: el("lastUpdated"),
      dashStatus: el("dashStatus"),

      // System panel (Cloudinary)
      cloudName: el("cloudName"),
      cloudFolder: el("cloudFolder"),

      dealerActions: el("dealerActions"),
      dealerViewControls: el("dealerViewControls"),
      dealerSelect: el("dealerSelect"),
      dealerRange: el("dealerRange"),
      dealerCustomRange: el("dealerCustomRange"),
      dealerStart: el("dealerStart"),
      dealerEnd: el("dealerEnd"),
      btnDealerViewRefresh: el("btnDealerViewRefresh"),
      newDealerName: el("newDealerName"),
      newDealerId: el("newDealerId"),
      newDealerStatus: el("newDealerStatus"),
      newDealerWhatsApp: el("newDealerWhatsApp"),
      newDealerLogo: el("newDealerLogo"),
      btnCreateDealer: el("btnCreateDealer"),
      btnOpenDealerModal: el("btnOpenDealerModal"),
      dealerActionStatus: el("dealerActionStatus"),

      mainTable: el("mainTable"),
      settingsPanel: el("settingsPanel"),
      settingLogoUrl: el("settingLogoUrl"),
      settingHeroVideoUrl: el("settingHeroVideoUrl"),
      btnSaveSettings: el("btnSaveSettings"),
      settingsStatus: el("settingsStatus"),
      dealerViewPanel: el("dealerViewPanel"),
      dealerViewHint: el("dealerViewHint"),
      dkInventory: el("dkInventory"),
      dkAvailable: el("dkAvailable"),
      dkSold: el("dkSold"),
      dkRequests: el("dkRequests"),
      dkNew: el("dkNew"),
      dkBooked: el("dkBooked"),
      dealerInvCount: el("dealerInvCount"),
      dealerInvUpdated: el("dealerInvUpdated"),
      dealerInvBody: el("dealerInvBody"),
      dealerLeadCount: el("dealerLeadCount"),
      dealerLeadUpdated: el("dealerLeadUpdated"),
      dealerLeadBody: el("dealerLeadBody"),

      dealerBackdrop: el("dealerBackdrop"),
      mClose: el("mClose"),
      mTitle: el("mTitle"),
      mSub: el("mSub"),
      mDealerName: el("mDealerName"),
      mDealerId: el("mDealerId"),
      mDealerStatus: el("mDealerStatus"),
      mDealerWhatsApp: el("mDealerWhatsApp"),
      mDealerLogo: el("mDealerLogo"),
      mPasscodeInput: el("mPasscodeInput"),
      btnResetPasscode: el("btnResetPasscode"),
      btnSaveDealer: el("btnSaveDealer"),
      mStatus: el("mStatus"),

      toast: el("toast"),
      toastDot: el("toastDot"),
      toastMsg: el("toastMsg"),
    };

    const state = {
      tab: "dealers",
      token: null,
      apiOnline: false,

      dealers: [],
      vehicles: [],
      requests: [],

      selectedDealer: null,
      dealerView: {
        dealerId: "",
        vehicles: [],
        leads: []
      },

      demoPasscodes: {},

      config: {
        cloudinary: { cloudName:"", baseFolder:"", uploadPreset:"" }
      },
      settings: {
        storefrontLogoUrl: "",
        storefrontHeroVideoUrl: ""
      }
    };

    document.addEventListener("DOMContentLoaded", async () => {
      wire();
      // nice for your test run
      ui.username.value = "adminpytch";
      ui.password.value = "123456";

      // Load public config (safe + unauthenticated)
      await loadPublicConfig();
      paintSystemPanel();
    });

    function wire(){
      ui.btnLogin.addEventListener("click", doLogin);
      ui.btnDemo.addEventListener("click", enterDemo);
      ui.password.addEventListener("keydown", (e)=>{ if(e.key==="Enter") doLogin(); });

      ui.btnLogout.addEventListener("click", logout);
      ui.btnRefresh.addEventListener("click", refresh);

      [ui.tabDealers, ui.tabInventory, ui.tabRequests, ui.tabDealerView, ui.tabSettings].forEach(btn=>{
        btn.addEventListener("click", ()=> setTab(btn.dataset.tab));
      });

      ui.q.addEventListener("keydown", (e)=>{ if(e.key==="Enter") render(); });
      ui.statusFilter.addEventListener("change", render);

      ui.btnCreateDealer.addEventListener("click", createDealer);
      ui.btnOpenDealerModal.addEventListener("click", () => {
        if(!state.dealers.length) return toast("No dealers yet. Create one first.", "error");
        openDealerModal(state.dealers[0]);
      });

      ui.mClose.addEventListener("click", closeDealerModal);
      ui.dealerBackdrop.addEventListener("click", (e)=>{ if(e.target === ui.dealerBackdrop) closeDealerModal(); });

      ui.btnResetPasscode.addEventListener("click", resetPasscode);
      ui.btnSaveDealer.addEventListener("click", saveDealerChanges);
      ui.btnSaveSettings.addEventListener("click", saveSettings);

      ui.dealerSelect.addEventListener("change", () => loadDealerView());
      ui.dealerRange.addEventListener("change", () => {
        ui.dealerCustomRange.style.display = ui.dealerRange.value === "custom" ? "grid" : "none";
        renderDealerView();
      });
      ui.dealerStart.addEventListener("change", renderDealerView);
      ui.dealerEnd.addEventListener("change", renderDealerView);
      ui.btnDealerViewRefresh.addEventListener("click", loadDealerView);
    }

    async function loadPublicConfig(){
      try{
        const res = await fetch(API.publicConfig(), { headers:{ "Accept":"application/json" }});
        const data = await safeJson(res);
        if(res.ok && data?.ok){
          state.config.cloudinary.cloudName = data.cloudinary?.cloudName || "";
          state.config.cloudinary.baseFolder = data.cloudinary?.baseFolder || "";
          state.config.cloudinary.uploadPreset = data.cloudinary?.uploadPreset || "";
        }
      }catch{
        // ignore
      }
    }

    function paintSystemPanel(){
      ui.cloudName.textContent = state.config.cloudinary.cloudName || "missing";
      ui.cloudFolder.textContent = state.config.cloudinary.baseFolder || "mediaexclusive";
    }

    function paintSettingsForm(){
      ui.settingLogoUrl.value = state.settings.storefrontLogoUrl || "";
      ui.settingHeroVideoUrl.value = state.settings.storefrontHeroVideoUrl || "";
    }

    async function loadSettings(){
      ui.settingsStatus.textContent = "";
      ui.settingsStatus.classList.remove("error");
      if(!state.apiOnline){
        paintSettingsForm();
        return;
      }
      try{
        const res = await fetch(API.settings(), { headers: authHeaders() });
        const data = await safeJson(res);
        if(!res.ok || !data?.ok) throw new Error(data?.error || "Failed to load settings");
        state.settings = data.settings || state.settings;
        paintSettingsForm();
      }catch(e){
        ui.settingsStatus.textContent = "Could not load settings.";
        ui.settingsStatus.classList.add("error");
      }
    }

    async function saveSettings(){
      ui.settingsStatus.textContent = "Saving…";
      ui.settingsStatus.classList.remove("error");

      const settings = {
        storefrontLogoUrl: (ui.settingLogoUrl.value || "").trim(),
        storefrontHeroVideoUrl: (ui.settingHeroVideoUrl.value || "").trim(),
      };

      try{
        if(!state.apiOnline){
          state.settings = { ...state.settings, ...settings };
          ui.settingsStatus.textContent = "Saved (demo).";
          toast("Settings updated.", "success");
          return;
        }
        const res = await fetch(API.settings(), {
          method:"POST",
          headers:{ ...authHeaders(), "Content-Type":"application/json", "Accept":"application/json" },
          body: JSON.stringify({ settings })
        });
        const data = await safeJson(res);
        if(!res.ok || !data?.ok) throw new Error(data?.error || "Save failed");
        state.settings = data.settings || settings;
        ui.settingsStatus.textContent = "Settings saved.";
        toast("Settings updated.", "success");
      }catch(e){
        ui.settingsStatus.textContent = "Failed to save settings.";
        ui.settingsStatus.classList.add("error");
        toast("Save failed: " + (e?.message||"error"), "error");
      }
    }

    async function doLogin(){
      const username = (ui.username.value||"").trim();
      const password = (ui.password.value||"").trim();
      if(!username || !password) return setLoginStatus("Enter username + password.", true);

      setLoginStatus("Signing in…", false);

      try{
        const res = await fetch(API.login(), {
          method:"POST",
          headers:{ "Content-Type":"application/json", "Accept":"application/json" },
          body: JSON.stringify({ username, password })
        });

        const data = await safeJson(res);
        if(!res.ok || !data?.ok) throw new Error(data?.error || "Login failed");

        state.apiOnline = true;
        state.token = data.token;
        setApi("Live", "on");
        enterDashboard(username);
      }catch(e){
        setApi("Error", "err");
        setLoginStatus("API login failed. Use Demo mode if you're testing UI only.", true);
      }
    }

    function enterDemo(){
      state.apiOnline = false;
      state.token = "demo-token";
      setApi("Demo", "err");
      enterDashboard("adminpytch");
    }

    function enterDashboard(username){
      ui.loginView.classList.add("hidden");
      ui.dashView.classList.remove("hidden");
      ui.whoami.textContent = `Admin · ${username}`;
      seedDemoIfNeeded();
      setTab("dealers");
      refresh();
      toast("Signed in.", "success");
    }

    function logout(){
      state.token = null;
      state.apiOnline = false;
      state.dealers = [];
      state.vehicles = [];
      state.requests = [];
      state.selectedDealer = null;

      ui.dashView.classList.add("hidden");
      ui.loginView.classList.remove("hidden");
      ui.loginStatus.textContent = "";
      toast("Logged out.", "success");
    }

    async function refresh(){
      ui.dashStatus.textContent = state.apiOnline ? "Loading from API…" : "Loading demo data…";
      ui.lastUpdated.textContent = "Updated: " + fmt(new Date());

      if(!state.apiOnline){
        ui.dashStatus.textContent = "Ready (demo).";
        if(state.tab === "dealerView"){
          populateDealerSelect();
          loadDealerView();
          return;
        }
        if(state.tab === "settings"){
          paintSettingsForm();
        }
        render();
        return;
      }

      try{
        if(state.tab === "dealers" || state.tab === "dealerView"){
          const res = await fetch(API.dealers(), { headers: authHeaders() });
          const data = await safeJson(res);
          if(!res.ok || !data?.ok) throw new Error(data?.error || "Failed to load dealers");
          state.dealers = Array.isArray(data.dealers) ? data.dealers : [];
        }
        if(state.tab === "settings"){
          await loadSettings();
        }
        if(state.tab === "inventory"){
          const res = await fetch(API.inventory(), { headers: authHeaders() });
          const data = await safeJson(res);
          if(!res.ok || !data?.ok) throw new Error(data?.error || "Failed to load inventory");
          state.vehicles = Array.isArray(data.vehicles) ? data.vehicles : [];
        }
        if(state.tab === "requests"){
          const res = await fetch(API.requests(), { headers: authHeaders() });
          const data = await safeJson(res);
          if(!res.ok || !data?.ok) throw new Error(data?.error || "Failed to load requests");
          state.requests = Array.isArray(data.requests) ? data.requests : [];
        }
        if(state.tab === "dealerView"){
          populateDealerSelect();
          await loadDealerView();
        }

        ui.dashStatus.textContent = "Ready.";
        setApi("Live", "on");
        render();
      }catch(e){
        ui.dashStatus.textContent = "Could not load from API.";
        setApi("Error", "err");
        toast("API error: " + (e?.message||"failed"), "error");
      }
    }

    function setTab(tab){
      state.tab = tab;

      ui.tabDealers.classList.toggle("active", tab==="dealers");
      ui.tabInventory.classList.toggle("active", tab==="inventory");
      ui.tabRequests.classList.toggle("active", tab==="requests");
      ui.tabDealerView.classList.toggle("active", tab==="dealerView");
      ui.tabSettings.classList.toggle("active", tab==="settings");

      ui.tableTitle.textContent =
        tab==="dealers" ? "Dealers"
        : tab==="inventory" ? "Inventory"
        : tab==="requests" ? "Viewing requests"
        : tab==="dealerView" ? "Dealer dashboard"
        : "Platform settings";

      ui.hint.textContent =
        tab==="dealers" ? "Create and manage dealer accounts. Reset passcodes. Set WhatsApp + branding."
        : tab==="inventory" ? "Search across all dealers. Verify status and listing quality."
        : tab==="requests" ? "Monitor incoming leads. Promote from New → Booked → Closed."
        : tab==="dealerView" ? "Choose a dealer to view KPIs, inventory, and leads."
        : "Update storefront branding and shared media.";

      ui.dealerActions.classList.toggle("hidden", tab!=="dealers");
      ui.dealerViewControls.classList.toggle("hidden", tab!=="dealerView");
      ui.mainTable.classList.toggle("hidden", tab==="dealerView" || tab==="settings");
      ui.dealerViewPanel.classList.toggle("hidden", tab!=="dealerView");
      ui.settingsPanel.classList.toggle("hidden", tab!=="settings");

      buildStatusFilterOptions(tab);
      buildTableHeaders(tab);

      refresh();
    }

    function buildStatusFilterOptions(tab){
      ui.statusFilter.innerHTML = "";
      const add = (v, t) => {
        const o = document.createElement("option");
        o.value = v; o.textContent = t;
        ui.statusFilter.appendChild(o);
      };

      add("", "All");

      if(tab === "dealers"){
        add("active", "Active");
        add("paused", "Paused");
      } else if(tab === "inventory"){
        add("available", "Available");
        add("pending", "Pending");
        add("sold", "Sold");
      } else if(tab === "requests"){
        add("new", "New");
        add("booked", "Booked");
        add("closed", "Closed");
      } else if(tab === "dealerView"){
        add("", "All");
      } else {
        add("", "All");
      }

      ui.statusFilterWrap.classList.toggle("hidden", tab==="settings" || tab==="dealerView");
    }

    function buildTableHeaders(tab){
      ui.theadRow.innerHTML = "";

      const cols =
        tab==="dealers" ? ["Dealer", "Dealer ID", "Status", "WhatsApp", "Vehicles"]
        : tab==="inventory" ? ["Vehicle", "Dealer", "Status", "Price", "Updated"]
        : tab==="requests" ? ["Customer", "Vehicle", "Dealer", "Status", "Requested"]
        : ["Item", "Value", "Hint", "Scope", "Action"];

      cols.forEach(c=>{
        const th = document.createElement("th");
        th.textContent = c;
        ui.theadRow.appendChild(th);
      });
    }

    function render(){
      const q = (ui.q.value||"").trim().toLowerCase();
      const f = (ui.statusFilter.value||"").trim().toLowerCase();

      let rows = [];
      if(state.tab==="dealerView"){
        renderDealerView();
        return;
      }
      if(state.tab==="settings"){
        return;
      }
      if(state.tab==="dealers") rows = [...state.dealers];
      if(state.tab==="inventory") rows = [...state.vehicles];
      if(state.tab==="requests") rows = [...state.requests];

      if(q){
        rows = rows.filter(r => JSON.stringify(r).toLowerCase().includes(q));
      }
      if(f && state.tab!=="settings"){
        rows = rows.filter(r => (r.status||"").toLowerCase() === f);
      }

      ui.tbody.innerHTML = "";
      ui.count.textContent = String(rows.length);

      if(!rows.length){
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 5;
        td.style.color = "var(--muted)";
        td.style.padding = "14px";
        td.textContent = "No rows match your filters.";
        tr.appendChild(td);
        ui.tbody.appendChild(tr);
        return;
      }

      rows.forEach(r=>{
        const tr = document.createElement("tr");

        if(state.tab==="dealers"){
          tr.style.cursor = "pointer";
          tr.addEventListener("click", ()=> openDealerModal(r));

          tr.appendChild(cell(`<div style="font-weight:900">${esc(r.name||"—")}</div><div style="color:var(--muted);font-size:11px;margin-top:2px">Branding + WhatsApp controls</div>`));
          tr.appendChild(cell(`<span class="mono">${esc(r.dealerId||"—")}</span>`));
          tr.appendChild(cell(dealerStatusPill(r.status)));
          tr.appendChild(cell(r.whatsapp ? `<span class="badgeMini">+${esc(r.whatsapp)}</span>` : `<span style="color:var(--muted)">—</span>`));
          tr.appendChild(cell(`<span class="badgeMini">${Number(r.vehicleCount||0)} vehicles</span>`));
        }

        if(state.tab==="inventory"){
          tr.appendChild(cell(`<div class="mono">${esc(r.vehicleId||r.id||"—")}</div><div style="color:var(--muted);font-size:11px;margin-top:2px">${esc(r.make||"")} ${esc(r.model||"")}</div>`));
          tr.appendChild(cell(`<span class="badgeMini">${esc(r.dealerId||"—")}</span>`));
          tr.appendChild(cell(invStatusPill(r.status)));
          tr.appendChild(cell(`<div style="font-weight:900">${money(r.price)}</div>`));
          tr.appendChild(cell(`<span class="mono">${esc(r.updated||r.updatedAt||r.createdAt||"—")}</span>`));
        }

        if(state.tab==="requests"){
          tr.appendChild(cell(`<div style="font-weight:900">${esc(r.customer||r.name||"—")}</div><div style="color:var(--muted);font-size:11px;margin-top:2px">${esc(r.phone||"")}</div>`));
          tr.appendChild(cell(`<div class="mono">${esc(r.vehicleId||"—")}</div>`));
          tr.appendChild(cell(`<span class="badgeMini">${esc(r.dealerId||"—")}</span>`));
          tr.appendChild(cell(reqPill(r.status)));
          tr.appendChild(cell(`<span class="mono">${esc(r.requested||r.createdAt||"—")}</span>`));
        }

        if(state.tab==="settings"){
          tr.appendChild(cell(`<div style="font-weight:900">${esc(r.item)}</div>`));
          tr.appendChild(cell(`<span class="mono">${esc(r.value)}</span>`));
          tr.appendChild(cell(`<span style="color:var(--muted)">${esc(r.hint)}</span>`));
          tr.appendChild(cell(`<span class="badgeMini">${esc(r.scope)}</span>`));
          tr.appendChild(cell(r.actionHtml || `<span style="color:var(--muted)">—</span>`));
        }

        ui.tbody.appendChild(tr);
      });
    }

    function populateDealerSelect(){
      const current = ui.dealerSelect.value || state.dealerView.dealerId;
      ui.dealerSelect.innerHTML = "";
      const dealers = state.dealers || [];
      if(!dealers.length){
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "No dealers available";
        ui.dealerSelect.appendChild(opt);
        return;
      }
      dealers.forEach((d) => {
        const opt = document.createElement("option");
        opt.value = d.dealerId;
        opt.textContent = `${d.name || d.dealerId} (${d.dealerId})`;
        ui.dealerSelect.appendChild(opt);
      });
      if(current && dealers.some(d => d.dealerId === current)){
        ui.dealerSelect.value = current;
      }
      state.dealerView.dealerId = ui.dealerSelect.value || dealers[0].dealerId;
    }

    function isValidDealerId(v){
      return /^[A-Za-z]{2}\d{3,5}$/.test(String(v || "").trim());
    }

    function rangeDates(){
      const mode = ui.dealerRange.value;
      if(mode === "custom"){
        const start = ui.dealerStart.value ? new Date(ui.dealerStart.value) : null;
        const end = ui.dealerEnd.value ? new Date(ui.dealerEnd.value) : null;
        return { start, end };
      }
      const days = Number(mode || 7);
      const end = new Date();
      const start = new Date();
      start.setDate(end.getDate() - (days - 1));
      return { start, end };
    }

    async function loadDealerView(){
      const dealerId = ui.dealerSelect.value || state.dealerView.dealerId;
      if(!dealerId) return;
      state.dealerView.dealerId = dealerId;
      ui.dealerViewHint.textContent = `Viewing ${dealerId}`;

      if(!state.apiOnline){
        state.dealerView.vehicles = state.vehicles.filter(v => v.dealerId === dealerId);
        state.dealerView.leads = state.requests.filter(r => r.dealerId === dealerId);
        ui.dealerInvUpdated.textContent = "Updated: " + fmt(new Date());
        ui.dealerLeadUpdated.textContent = "Updated: " + fmt(new Date());
        renderDealerView();
        return;
      }

      try{
        const [invRes, leadRes] = await Promise.all([
          fetch(API.dealerVehicles(dealerId), { headers: authHeaders() }),
          fetch(API.dealerLeads(dealerId), { headers: authHeaders() })
        ]);
        const invData = await safeJson(invRes);
        const leadData = await safeJson(leadRes);
        if(!invRes.ok || !invData?.ok) throw new Error(invData?.error || "Failed to load dealer inventory");
        if(!leadRes.ok || !leadData?.ok) throw new Error(leadData?.error || "Failed to load dealer leads");

        state.dealerView.vehicles = Array.isArray(invData.vehicles) ? invData.vehicles : [];
        state.dealerView.leads = Array.isArray(leadData.leads) ? leadData.leads : [];
        ui.dealerInvUpdated.textContent = "Updated: " + fmt(new Date());
        ui.dealerLeadUpdated.textContent = "Updated: " + fmt(new Date());
        renderDealerView();
      }catch(e){
        ui.dealerViewHint.textContent = "Failed to load dealer view.";
        toast("Dealer view load failed: " + (e?.message || "error"), "error");
      }
    }

    function renderDealerView(){
      if(state.tab !== "dealerView") return;
      const dealerId = state.dealerView.dealerId;
      if(!dealerId){
        ui.dealerViewHint.textContent = "Select a dealer to view data.";
        return;
      }

      const { start, end } = rangeDates();
      const leads = state.dealerView.leads || [];
      const vehicles = state.dealerView.vehicles || [];

      const inRange = leads.filter((l) => {
        if(!start && !end) return true;
        const created = l.createdAt ? new Date(l.createdAt) : null;
        if(start && created && created < start) return false;
        if(end && created && created > new Date(end.getTime() + 86400000)) return false;
        return true;
      });

      ui.dkInventory.textContent = String(vehicles.length);
      ui.dkAvailable.textContent = String(vehicles.filter(v => (v.status||"").toLowerCase() === "available").length);
      ui.dkSold.textContent = String(vehicles.filter(v => (v.status||"").toLowerCase() === "sold").length);
      ui.dkRequests.textContent = String(inRange.length);
      ui.dkNew.textContent = String(inRange.filter(l => (l.status||"").toLowerCase() === "new").length);
      ui.dkBooked.textContent = String(inRange.filter(l => (l.status||"").toLowerCase() === "booked").length);

      ui.dealerInvBody.innerHTML = "";
      ui.dealerInvCount.textContent = String(vehicles.length);
      if(!vehicles.length){
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 4;
        td.style.color = "var(--muted)";
        td.style.padding = "14px";
        td.textContent = "No vehicles for this dealer.";
        tr.appendChild(td);
        ui.dealerInvBody.appendChild(tr);
      } else {
        vehicles.forEach((v) => {
          const tr = document.createElement("tr");
          tr.appendChild(cell(`<div class="mono">${esc(v.vehicleId||"—")}</div><div style="color:var(--muted);font-size:11px;margin-top:2px">${esc(v.make||"")} ${esc(v.model||"")}</div>`));
          tr.appendChild(cell(invStatusPill(v.status)));
          tr.appendChild(cell(`<div style="font-weight:900">${money(v.price)}</div>`));
          tr.appendChild(cell(`<span class="mono">${esc(v.updatedAt||v.createdAt||"—")}</span>`));
          ui.dealerInvBody.appendChild(tr);
        });
      }

      ui.dealerLeadBody.innerHTML = "";
      ui.dealerLeadCount.textContent = String(leads.length);
      if(!leads.length){
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 6;
        td.style.color = "var(--muted)";
        td.style.padding = "14px";
        td.textContent = "No requests for this dealer.";
        tr.appendChild(td);
        ui.dealerLeadBody.appendChild(tr);
      } else {
        leads.forEach((l) => {
          const tr = document.createElement("tr");
          tr.appendChild(cell(`<div style="font-weight:900">${esc(l.name||"—")}</div><div style="color:var(--muted);font-size:11px;margin-top:2px">${esc(l.phone||"")}</div>`));
          tr.appendChild(cell(`<div class="mono">${esc(l.vehicleId||"—")}</div>`));
          tr.appendChild(cell(`<span class="badgeMini">${esc(l.type||"lead")}</span>`));
          tr.appendChild(cell(reqPill(l.status)));
          tr.appendChild(cell(`<span class="mono">${esc(l.createdAt||"—")}</span>`));

          const actions = document.createElement("td");
          const booked = document.createElement("button");
          booked.className = "btn btn-ghost";
          booked.textContent = "Book";
          booked.onclick = () => updateDealerLeadStatus(dealerId, l.leadId, "booked");

          const closed = document.createElement("button");
          closed.className = "btn btn-ghost";
          closed.textContent = "Close";
          closed.onclick = () => updateDealerLeadStatus(dealerId, l.leadId, "closed");

          actions.appendChild(booked);
          actions.appendChild(closed);
          tr.appendChild(actions);

          ui.dealerLeadBody.appendChild(tr);
        });
      }
    }

    async function updateDealerLeadStatus(dealerId, leadId, status){
      if(!dealerId || !leadId) return;
      if(!state.apiOnline){
        const idx = state.dealerView.leads.findIndex(l => l.leadId === leadId);
        if(idx > -1) state.dealerView.leads[idx].status = status;
        renderDealerView();
        return;
      }

      try{
        const res = await fetch(API.dealerLeadStatus(dealerId), {
          method:"POST",
          headers:{ ...authHeaders(), "Content-Type":"application/json", "Accept":"application/json" },
          body: JSON.stringify({ leadId, status })
        });
        const data = await safeJson(res);
        if(!res.ok || !data?.ok) throw new Error(data?.error || "Update failed");
        const idx = state.dealerView.leads.findIndex(l => l.leadId === leadId);
        if(idx > -1) state.dealerView.leads[idx].status = status;
        renderDealerView();
      }catch(e){
        toast("Lead update failed.", "error");
      }
    }

    // =============================
    // Dealer Modal
    // =============================
    function openDealerModal(dealer){
      state.selectedDealer = { ...dealer };
      ui.mTitle.textContent = "Dealer editor";
      ui.mSub.textContent = "Update dealer profile, branding, and passcode.";
      ui.mStatus.textContent = "";

      ui.mDealerName.value = dealer.name || "";
      ui.mDealerId.value = dealer.dealerId || "";
      ui.mDealerStatus.value = (dealer.status || "active").toLowerCase();
      ui.mDealerWhatsApp.value = dealer.whatsapp || "";
      ui.mDealerLogo.value = dealer.logoUrl || dealer.logo || "";

      const demoPass = state.demoPasscodes[dealer.dealerId];
      ui.mPasscodeInput.value = demoPass || dealer.passcode || "";

      ui.dealerBackdrop.classList.add("show");
      ui.dealerBackdrop.setAttribute("aria-hidden","false");
    }

    function closeDealerModal(){
      ui.dealerBackdrop.classList.remove("show");
      ui.dealerBackdrop.setAttribute("aria-hidden","true");
      state.selectedDealer = null;
    }

    async function saveDealerChanges(){
      if(!state.selectedDealer) return;

      const payload = {
        dealerId: (ui.mDealerId.value||"").trim().toUpperCase(),
        name: (ui.mDealerName.value||"").trim(),
        status: (ui.mDealerStatus.value||"active").toLowerCase(),
        whatsapp: digits(ui.mDealerWhatsApp.value||""),
        logoUrl: (ui.mDealerLogo.value||"").trim(),
      };
      const passcode = (ui.mPasscodeInput.value||"").trim();
      if(passcode){
        payload.passcode = passcode;
      }

      if(!payload.dealerId || !payload.name){
        ui.mStatus.textContent = "Dealer ID and name are required.";
        ui.mStatus.classList.add("error");
        return;
      }
      if(!isValidDealerId(payload.dealerId)){
        ui.mStatus.textContent = "Dealer ID must be two letters followed by 3-5 numbers.";
        ui.mStatus.classList.add("error");
        return;
      }
      if(payload.passcode && !/^\d{6}$/.test(payload.passcode)){
        ui.mStatus.textContent = "Passcode must be exactly 6 digits.";
        ui.mStatus.classList.add("error");
        return;
      }

      ui.mStatus.textContent = "Saving…";
      ui.mStatus.classList.remove("error");

      try{
        if(!state.apiOnline){
          const idx = state.dealers.findIndex(d => d.dealerId === state.selectedDealer.dealerId);
          if(idx>-1){
            state.dealers[idx] = { ...state.dealers[idx], ...payload, passcode: payload.passcode || state.dealers[idx].passcode };
          }
          ui.mStatus.textContent = "Saved (demo).";
          toast("Dealer updated.", "success");
          render();
          return;
        }

        const res = await fetch(API.dealers(), {
          method:"POST",
          headers:{ ...authHeaders(), "Content-Type":"application/json", "Accept":"application/json" },
          body: JSON.stringify(payload)
        });
        const data = await safeJson(res);
        if(!res.ok || !data?.ok) throw new Error(data?.error || "Save failed");

        ui.mStatus.textContent = "Saved.";
        toast("Dealer updated.", "success");
        if(data.passcode) ui.mPasscodeInput.value = String(data.passcode);
        await refresh();
      }catch(e){
        ui.mStatus.textContent = "Failed to save.";
        ui.mStatus.classList.add("error");
        toast("Save failed: " + (e?.message||"error"), "error");
      }
    }

    async function resetPasscode(){
      if(!state.selectedDealer) return;

      ui.mStatus.textContent = "Resetting passcode…";
      ui.mStatus.classList.remove("error");

      const dealerId = (ui.mDealerId.value||"").trim();

      try{
        if(!state.apiOnline){
          const newPass = String(Math.floor(100000 + Math.random()*900000));
          state.demoPasscodes[dealerId] = newPass;
          ui.mPasscodeInput.value = newPass;
          ui.mStatus.textContent = "Passcode reset (demo).";
          toast("Passcode reset.", "success");
          return;
        }

        const res = await fetch(API.resetPass(), {
          method:"POST",
          headers:{ ...authHeaders(), "Content-Type":"application/json", "Accept":"application/json" },
          body: JSON.stringify({ dealerId })
        });
        const data = await safeJson(res);
        if(!res.ok || !data?.ok) throw new Error(data?.error || "Reset failed");

        if(data.passcode) ui.mPasscodeInput.value = String(data.passcode);

        ui.mStatus.textContent = "Passcode reset.";
        toast("Passcode reset.", "success");
        await refresh();
      }catch(e){
        ui.mStatus.textContent = "Failed to reset passcode.";
        ui.mStatus.classList.add("error");
        toast("Reset failed: " + (e?.message||"error"), "error");
      }
    }

    // =============================
    // Dealer creation
    // =============================
    async function createDealer(){
      const payload = {
        name: (ui.newDealerName.value||"").trim(),
        dealerId: (ui.newDealerId.value||"").trim().toUpperCase(),
        status: (ui.newDealerStatus.value||"active").toLowerCase(),
        whatsapp: digits(ui.newDealerWhatsApp.value||""),
        logoUrl: (ui.newDealerLogo.value||"").trim(),
      };

      if(!payload.name || !payload.dealerId){
        ui.dealerActionStatus.textContent = "Dealer name and ID are required.";
        ui.dealerActionStatus.classList.add("error");
        return;
      }
      if(!isValidDealerId(payload.dealerId)){
        ui.dealerActionStatus.textContent = "Dealer ID must be two letters followed by 3-5 numbers.";
        ui.dealerActionStatus.classList.add("error");
        return;
      }

      ui.dealerActionStatus.textContent = "Creating…";
      ui.dealerActionStatus.classList.remove("error");

      try{
        if(!state.apiOnline){
          const exists = state.dealers.some(d => d.dealerId === payload.dealerId);
          if(exists) throw new Error("Dealer ID already exists (demo).");

          const pass = String(Math.floor(100000 + Math.random()*900000));
          state.demoPasscodes[payload.dealerId] = pass;

          state.dealers.unshift({
            name: payload.name,
            dealerId: payload.dealerId,
            status: payload.status,
            whatsapp: payload.whatsapp,
            logoUrl: payload.logoUrl,
            passcode: pass,
            vehicleCount: 0
          });

          ui.dealerActionStatus.textContent = `Created (demo). Passcode: ${pass}`;
          toast("Dealer created.", "success");
          clearCreateInputs();
          render();
          return;
        }

        const res = await fetch(API.dealers(), {
          method:"POST",
          headers:{ ...authHeaders(), "Content-Type":"application/json", "Accept":"application/json" },
          body: JSON.stringify(payload)
        });
        const data = await safeJson(res);
        if(!res.ok || !data?.ok) throw new Error(data?.error || "Create failed");

        if(data.passcode){
          ui.dealerActionStatus.textContent = `Created. New passcode: ${data.passcode}`;
        } else {
          ui.dealerActionStatus.textContent = "Created.";
        }

        toast("Dealer created.", "success");
        clearCreateInputs();
        await refresh();
      }catch(e){
        ui.dealerActionStatus.textContent = "Failed to create dealer.";
        ui.dealerActionStatus.classList.add("error");
        toast("Create failed: " + (e?.message||"error"), "error");
      }
    }

    function clearCreateInputs(){
      ui.newDealerName.value = "";
      ui.newDealerId.value = "";
      ui.newDealerWhatsApp.value = "";
      ui.newDealerLogo.value = "";
      ui.newDealerStatus.value = "active";
    }

    // =============================
    // Demo seed data
    // =============================
    function seedDemoIfNeeded(){
      if(state.dealers.length) return;

      state.dealers = [
        { name:"Pytch Motors", dealerId:"AA123", status:"active", whatsapp:"8765550123", logoUrl:"", vehicleCount:12 },
        { name:"Island Auto", dealerId:"BB456", status:"active", whatsapp:"8765550199", logoUrl:"", vehicleCount:7 },
        { name:"Mobay Cars", dealerId:"CC789", status:"paused", whatsapp:"", logoUrl:"", vehicleCount:3 },
      ];

      state.demoPasscodes["AA123"] = "123456";

      state.vehicles = [
        { vehicleId:"VEH-10021", dealerId:"AA123", make:"Toyota", model:"Vitz", status:"available", price:1250000, updated: fmt(new Date(Date.now()-3600*1000*8)) },
        { vehicleId:"VEH-10022", dealerId:"AA123", make:"Honda", model:"Civic", status:"pending", price:2200000, updated: fmt(new Date(Date.now()-3600*1000*19)) },
        { vehicleId:"VEH-10031", dealerId:"BB456", make:"Nissan", model:"Note", status:"available", price:1450000, updated: fmt(new Date(Date.now()-3600*1000*5)) },
        { vehicleId:"VEH-10041", dealerId:"CC789", make:"BMW", model:"3 Series", status:"sold", price:3950000, updated: fmt(new Date(Date.now()-3600*1000*66)) },
      ];

      state.requests = [
        { customer:"Andre W.", phone:"876-555-0192", vehicleId:"VEH-10022", dealerId:"AA123", status:"new", requested: fmt(new Date(Date.now()-3600*1000*2)) },
        { customer:"Kiera M.", phone:"876-555-0113", vehicleId:"VEH-10021", dealerId:"AA123", status:"booked", requested: fmt(new Date(Date.now()-3600*1000*10)) },
        { customer:"Damien R.", phone:"876-555-0177", vehicleId:"VEH-10031", dealerId:"BB456", status:"closed", requested: fmt(new Date(Date.now()-3600*1000*30)) },
      ];
    }

    // =============================
    // UI helpers
    // =============================
    function cell(html){
      const td = document.createElement("td");
      td.innerHTML = html;
      return td;
    }

    function dealerStatusPill(s){
      const v = (s||"active").toLowerCase();
      const cls = v==="paused" ? "paused" : "active";
      return `<span class="status ${cls}">${esc(v)}</span>`;
    }
    function invStatusPill(s){
      const v = (s||"available").toLowerCase();
      const cls = v==="available" ? "available" : v==="pending" ? "pending" : "sold";
      return `<span class="status ${cls}">${esc(v)}</span>`;
    }
    function reqPill(s){
      const v = (s||"new").toLowerCase();
      const cls = v==="new" ? "reqNew" : v==="booked" ? "reqBooked" : "reqClosed";
      return `<span class="status ${cls}">${esc(v)}</span>`;
    }

    function setApi(text, mode){
      ui.apiStatus.textContent = text || "—";
      ui.apiDot.classList.remove("on","err");
      if(mode==="on") ui.apiDot.classList.add("on");
      if(mode==="err") ui.apiDot.classList.add("err");
    }

    function setLoginStatus(msg, err){
      ui.loginStatus.textContent = msg || "";
      ui.loginStatus.classList.toggle("error", !!err);
    }

    function toast(message, type){
      ui.toastMsg.textContent = message || "";
      ui.toast.classList.remove("success","error");
      if(type==="success"){ ui.toast.classList.add("success"); ui.toastDot.style.background="#22c55e"; }
      else if(type==="error"){ ui.toast.classList.add("error"); ui.toastDot.style.background="#ef4444"; }
      else ui.toastDot.style.background="var(--brand)";
      ui.toast.classList.add("show");
      clearTimeout(window.__t);
      window.__t = setTimeout(()=>ui.toast.classList.remove("show"), 3200);
    }

    function authHeaders(){
      return {
        "Accept":"application/json",
        "Authorization":"Bearer " + state.token
      };
    }

    async function safeJson(res){
      try{ return await res.json(); }catch(_){ return null; }
    }

    function money(n){
      const v = Number(n);
      if(!Number.isFinite(v) || v<=0) return "—";
      return "JMD " + v.toLocaleString(undefined,{maximumFractionDigits:0});
    }

    function fmt(d){
      const dt = (d instanceof Date)?d:new Date(d);
      const day = String(dt.getDate()).padStart(2,"0");
      const mon = String(dt.getMonth()+1).padStart(2,"0");
      const yr = String(dt.getFullYear()).slice(-2);
      const hr = String(dt.getHours()).padStart(2,"0");
      const mi = String(dt.getMinutes()).padStart(2,"0");
      return `${day}/${mon}/${yr} ${hr}:${mi}`;
    }

    function digits(s){
      return String(s||"").replace(/\D+/g,"").trim();
    }

    function esc(s){
      return String(s ?? "")
        .replaceAll("&","&amp;")
        .replaceAll("<","&lt;")
        .replaceAll(">","&gt;")
        .replaceAll('"',"&quot;")
        .replaceAll("'","&#39;");
    }
