// --------- State ----------
    let allVehicles = [];
    let filtered = [];
    let cloudCfg = { cloudName:"", baseFolder:"" };
    let storefrontSettings = { storefrontLogoUrl:"", storefrontHeroVideoUrl:"" };
    let currentDealerId = "";
    let dealerProfile = null;

    let booking = {
      dealerId: "",
      vehicleId: "",
      title: "",
      dealerName: ""
    };

    // --------- Helpers ----------
    function qs(id){ return document.getElementById(id); }
    function money(n){
      const x = Number(n || 0);
      if (!isFinite(x) || x <= 0) return "Price on request";
      return "J$ " + x.toLocaleString();
    }
    function norm(s){ return String(s || "").trim().toLowerCase(); }
    function isHttpUrl(u){ return typeof u === "string" && /^https?:\/\//i.test(u); }
    function digitsOnly(s){ return String(s || "").replace(/\\D+/g, ""); }
    function isValidDealerId(v){ return /^[A-Za-z]{2}\\d{3,5}$/.test(String(v || "").trim()); }
    function esc(s){
      return String(s ?? "")
        .replaceAll("&","&amp;")
        .replaceAll("<","&lt;")
        .replaceAll(">","&gt;")
        .replaceAll('"',"&quot;")
        .replaceAll("'","&#39;");
    }

    function buildWhatsAppLink(title, vehicleId){
      const digits = digitsOnly(dealerProfile?.whatsapp || "");
      if (!digits) return "#";
      const dealerName = dealerProfile?.name || "Dealer";
      const link = `${location.origin}/d/${encodeURIComponent(currentDealerId || "")}`;
      const messageParts = [
        `${dealerName} — WhatsApp request`,
        title ? `Vehicle: ${title}` : "",
        vehicleId ? `ID: ${vehicleId}` : "",
        `Link: ${link}`
      ].filter(Boolean);
      const text = encodeURIComponent(messageParts.join("\\n"));
      return `https://wa.me/${digits}?text=${text}`;
    }

    function showToast(msg, ok=true){
      const t = qs("toast");
      const d = t.querySelector(".d");
      qs("toastMsg").textContent = msg;
      t.classList.toggle("ok", !!ok);
      t.classList.toggle("bad", !ok);
      d.style.background = ok ? "var(--ok)" : "var(--brand)";
      t.style.display = "flex";
      setTimeout(()=> t.style.display="none", 3200);
    }

    function parseVehicleFromUrl(){
      const u = new URL(location.href);
      const vehicleId = u.searchParams.get("vehicleId") || "";
      if (vehicleId) qs("fSearch").value = vehicleId;
      return vehicleId;
    }

    function setDealerVisibility(hasDealer){
      qs("filters").style.display = hasDealer ? "flex" : "none";
      qs("kpis").style.display = hasDealer ? "grid" : "none";
      qs("resultsHead").style.display = hasDealer ? "flex" : "none";
    }

    function setLoadingSkeleton(){
      const grid = qs("grid");
      grid.innerHTML = "";
      for (let i=0;i<6;i++){
        const card = document.createElement("div");
        card.className = "card";
        const media = document.createElement("div");
        media.className = "media skeleton";
        const content = document.createElement("div");
        content.className = "content";
        const line1 = document.createElement("div");
        line1.className = "skeleton";
        line1.style.height="14px";
        line1.style.borderRadius="10px";
        const line2 = document.createElement("div");
        line2.className = "skeleton";
        line2.style.height="12px";
        line2.style.borderRadius="10px";
        line2.style.width="70%";
        const line3 = document.createElement("div");
        line3.className = "skeleton";
        line3.style.height="16px";
        line3.style.borderRadius="10px";
        line3.style.width="50%";
        content.appendChild(line1);
        content.appendChild(line2);
        content.appendChild(line3);
        card.appendChild(media);
        card.appendChild(content);
        grid.appendChild(card);
      }
      qs("empty").style.display = "none";
      qs("countMeta").textContent = "…";
    }

    // --------- Load config (optional) ----------
    async function loadConfig(){
      try{
        const res = await fetch("/api/public/config", { headers:{ "Accept":"application/json" }});
        const data = await res.json().catch(()=>null);
        cloudCfg.cloudName = data?.cloudinary?.cloudName || "";
        cloudCfg.baseFolder = data?.cloudinary?.baseFolder || "";
        storefrontSettings = {
          storefrontLogoUrl: data?.settings?.storefrontLogoUrl || "",
          storefrontHeroVideoUrl: data?.settings?.storefrontHeroVideoUrl || ""
        };
        currentDealerId = (data?.dealerId || "").trim().toUpperCase();
        applyHeroMedia();
      }catch{
        cloudCfg = { cloudName:"", baseFolder:"" };
        storefrontSettings = { storefrontLogoUrl:"", storefrontHeroVideoUrl:"" };
        currentDealerId = "";
        applyHeroMedia();
      }
    }

    async function loadDealerProfile(){
      if (!currentDealerId || !isValidDealerId(currentDealerId)) {
        dealerProfile = null;
        applyDealerBranding();
        return null;
      }
      try{
        const url = new URL("/api/public/dealer", location.origin);
        url.searchParams.set("dealerId", currentDealerId);
        const res = await fetch(url.toString(), { headers:{ "Accept":"application/json" }});
        const data = await res.json().catch(()=>null);
        dealerProfile = data?.dealer || null;
        applyDealerBranding();
        return dealerProfile;
      }catch{
        dealerProfile = null;
        applyDealerBranding();
        return null;
      }
    }

    function applyDealerBranding(){
      const badge = qs("dealerLogo");
      const fallbackLogo = storefrontSettings.storefrontLogoUrl;
      if (fallbackLogo && isHttpUrl(fallbackLogo)){
        badge.innerHTML = `<img src="${fallbackLogo}" alt="Storefront logo" />`;
      } else if (dealerProfile?.logoUrl && isHttpUrl(dealerProfile.logoUrl)){
        badge.innerHTML = `<img src="${dealerProfile.logoUrl}" alt="${esc(dealerProfile.name || "Dealer logo")}" />`;
      } else {
        badge.textContent = "C";
      }
      if (!currentDealerId){
        qs("storeTitle").textContent = "Carsales Storefront";
        qs("storeSub").textContent = "Inventory will appear once this storefront is connected.";
        qs("dealerPill").textContent = "Dealer";
        qs("whatsAppBtn").style.display = "none";
        return;
      }
      const name = dealerProfile?.name || "Live Inventory";
      qs("storeTitle").textContent = name;
      qs("storeSub").textContent = "Browse verified inventory and request a viewing in minutes.";
      qs("dealerPill").textContent = name;

      const wa = qs("whatsAppBtn");
      if (dealerProfile?.whatsapp){
        wa.href = buildWhatsAppLink("", "");
        wa.style.display = "inline-flex";
      } else {
        wa.style.display = "none";
      }
    }

    function applyHeroMedia(){
      const videoUrl = storefrontSettings.storefrontHeroVideoUrl || "";
      const logoUrl = storefrontSettings.storefrontLogoUrl || "";
      const heroVideo = qs("heroVideo");
      const heroImage = qs("heroImage");
      const heroFallback = qs("heroFallback");

      heroVideo.classList.remove("active");
      heroImage.classList.remove("active");
      heroVideo.removeAttribute("src");
      heroImage.removeAttribute("src");

      if (isHttpUrl(videoUrl)){
        heroVideo.src = videoUrl;
        heroVideo.classList.add("active");
        heroFallback.style.display = "none";
        return;
      }

      if (isHttpUrl(logoUrl)){
        heroImage.src = logoUrl;
        heroImage.classList.add("active");
        heroFallback.style.display = "none";
        return;
      }

      heroFallback.style.display = "block";
    }

    // --------- Fetch inventory ----------
    async function loadInventory(){
      const dealerId = currentDealerId;
      qs("dealerPill").textContent = dealerProfile?.name ? dealerProfile.name : (dealerId || "Dealer");
      qs("invalidLink").style.display = dealerId ? "none" : "block";
      setDealerVisibility(!!dealerId);
      if (!dealerId){
        allVehicles = [];
        render([]);
        return;
      }
      if (!isValidDealerId(dealerId)){
        qs("invalidLink").style.display = "block";
        setDealerVisibility(false);
        allVehicles = [];
        render([]);
        return;
      }

      const url = new URL("/api/public/vehicles", location.origin);
      url.searchParams.set("dealerId", dealerId);

      setLoadingSkeleton();

      try{
        const res = await fetch(url.toString(), { headers: { "Accept":"application/json" }});
        const data = await res.json().catch(()=>null);
        allVehicles = (data && Array.isArray(data.vehicles)) ? data.vehicles : [];
        buildFilterOptions(allVehicles);
        applyFilters();
      }catch(e){
        allVehicles = [];
        render([]);
        showToast("Could not load inventory. Try refresh.", false);
      }
    }

    function buildFilterOptions(list){
      const makes = new Set();
      const models = new Set();
      const years = new Set();

      list.forEach(v=>{
        if (v.make) makes.add(String(v.make));
        if (v.model) models.add(String(v.model));
        if (v.year) years.add(String(v.year));
      });

      fillSelect("fMake", makes);
      fillSelect("fModel", models);
      fillSelect("fYear", years, true);
    }

    function fillSelect(id, set, numeric=false){
      const sel = qs(id);
      const current = sel.value;
      const arr = Array.from(set);

      arr.sort((a,b)=>{
        if (numeric) return Number(a)-Number(b);
        return a.localeCompare(b);
      });

      sel.innerHTML = "";
      const opt0 = document.createElement("option");
      opt0.value = "";
      opt0.textContent = "All";
      sel.appendChild(opt0);

      arr.forEach(v=>{
        const o = document.createElement("option");
        o.value = v;
        o.textContent = v;
        sel.appendChild(o);
      });

      const exists = Array.from(sel.options).some(o=>o.value===current);
      if (exists) sel.value = current;
    }

    // --------- Filters / Sort ----------
    function applyFilters(){
      const q = norm(qs("fSearch").value);
      const make = qs("fMake").value;
      const model = qs("fModel").value;
      const year = qs("fYear").value;
      const sort = qs("fSort").value;

      filtered = allVehicles.filter(v=>{
        const text = norm([
          v.vehicleId,
          v.title,
          v.make,
          v.model,
          v.notes,
          v.mileage,
          v.transmission,
          v.fuelType,
          v.bodyType,
          v.color,
          v.vin
        ].join(" "));
        if (q && !text.includes(q)) return false;
        if (make && String(v.make||"") !== make) return false;
        if (model && String(v.model||"") !== model) return false;
        if (year && String(v.year||"") !== year) return false;
        return true;
      });

      const byDate = (a,b)=> (new Date(b.updatedAt||b.createdAt||0)) - (new Date(a.updatedAt||a.createdAt||0));
      const byPriceAsc = (a,b)=> (Number(a.price||0) - Number(b.price||0));
      const byPriceDesc = (a,b)=> (Number(b.price||0) - Number(a.price||0));
      const byYearAsc = (a,b)=> (Number(a.year||0) - Number(b.year||0));
      const byYearDesc = (a,b)=> (Number(b.year||0) - Number(a.year||0));

      if (sort==="price_asc") filtered.sort(byPriceAsc);
      else if (sort==="price_desc") filtered.sort(byPriceDesc);
      else if (sort==="year_asc") filtered.sort(byYearAsc);
      else if (sort==="year_desc") filtered.sort(byYearDesc);
      else filtered.sort(byDate);

      render(filtered);
      updateKpis(filtered);
    }

    const tips = [
      "Ask for a live video viewing to confirm the condition.",
      "Send a walk-in request to lock a time slot today.",
      "Compare trims and mileage — we’ll share the details fast.",
      "Short on time? Use WhatsApp for a quick response.",
    ];
    let tipIndex = 0;

    function rotateTip(){
      tipIndex = (tipIndex + 1) % tips.length;
      qs("kTip").textContent = tips[tipIndex];
    }

    function updateKpis(list){
      qs("kTotal").textContent = String(list.length);

      // most common make
      const counts = {};
      list.forEach(v=>{
        const m = String(v.make||"").trim();
        if (!m) return;
        counts[m] = (counts[m]||0)+1;
      });
      let top = "—", topN = 0;
      Object.keys(counts).forEach(k=>{
        if (counts[k] > topN){ topN=counts[k]; top=k; }
      });
      qs("kMake").textContent = top;

      // price range
      const prices = list.map(v=>Number(v.price||0)).filter(n=>isFinite(n) && n>0);
      if (!prices.length) qs("kRange").textContent = "—";
      else {
        const min = Math.min(...prices), max = Math.max(...prices);
        qs("kRange").textContent = "J$ " + min.toLocaleString() + " → " + "J$ " + max.toLocaleString();
      }

      if (!list.length) qs("kTip").textContent = "Try clearing filters or searching by make/model.";
      else qs("kTip").textContent = tips[tipIndex];
    }

    // --------- Media helper (Cloudinary URLs in Sheets) ----------
    // The NEW server returns:
    //   v.heroImage: "https://res.cloudinary.com/.../image/upload/..."
    //   v.images: ["https://res.cloudinary.com/..."]
    // We still tolerate old shapes just in case.
    function pickHeroUrl(v){
      const hero = v?.heroImage || v?.heroImageUrl || "";
      if (isHttpUrl(hero)) return hero;

      const images = Array.isArray(v?.images) ? v.images : [];
      const first = images.find(isHttpUrl);
      if (first) return first;

      // Back-compat: v.media.images = [{publicUrl}] or ["..."]
      const imgs = v?.media?.images;
      if (Array.isArray(imgs) && imgs.length){
        const x = imgs[0];
        if (typeof x === "string" && isHttpUrl(x)) return x;
        if (x && isHttpUrl(x.publicUrl)) return x.publicUrl;
        if (x && isHttpUrl(x.url)) return x.url;
      }
      return "";
    }

    // Optional: Cloudinary transform for faster thumbnails.
    // Works best with Cloudinary URLs; if it’s not Cloudinary, we return the original.
    function thumb(url){
      try{
        if (!isHttpUrl(url)) return "";
        // Only transform Cloudinary URLs
        if (!/res\.cloudinary\.com\/[^/]+\/image\/upload\//i.test(url)) return url;

        // Insert transformation after /upload/
        // (keep it simple: auto format + quality + fill crop)
        return url.replace(/\/image\/upload\//i, "/image/upload/f_auto,q_auto,c_fill,w_900,h_520/");
      }catch{
        return url;
      }
    }

    function deriveTitle(v){
      return v.title || [v.year, v.make, v.model].filter(Boolean).join(" ") || "Vehicle";
    }

    // --------- Render cards ----------
    function render(list){
      const grid = qs("grid");
      grid.innerHTML = "";
      qs("countMeta").textContent = String(list.length);
      qs("empty").style.display = list.length ? "none" : "block";

      list.forEach(v=>{
        const title = deriveTitle(v);
        const dealerId = currentDealerId || v.dealerId || "unknown";
        const vehicleId = v.vehicleId || "unknown";
        const status = String(v.status||"").toLowerCase();

        const card = document.createElement("div");
        card.className = "card";

        const media = document.createElement("div");
        media.className = "media";

        const tag = document.createElement("div");
        tag.className = "tag";
        tag.innerHTML = `<span class="miniDot"></span><span>Verified dealer</span>`;
        media.appendChild(tag);

        const hero = pickHeroUrl(v);
        if (hero){
          const img = document.createElement("img");
          img.alt = title;
          img.loading = "lazy";
          img.src = thumb(hero);
          img.referrerPolicy = "no-referrer";
          img.onerror = () => {
            // if transformed url fails, fall back to original
            if (img.src !== hero) img.src = hero;
          };
          media.appendChild(img);
        } else {
          media.appendChild(document.createTextNode("Photos coming soon"));
        }

        const c = document.createElement("div");
        c.className = "content";

        const t = document.createElement("div");
        t.className = "title";
        t.textContent = title;

        const meta = document.createElement("div");
        meta.className = "meta";
        meta.textContent = [
          v.year ? String(v.year) : "",
          v.make ? String(v.make) : "",
          v.model ? String(v.model) : ""
        ].filter(Boolean).join(" • ") || "Details available on request";

        const specs = document.createElement("div");
        specs.className = "specs";
        const specParts = [];
        if (v.mileage != null && v.mileage !== "") specParts.push(`${Number(v.mileage).toLocaleString()} km`);
        if (v.transmission) specParts.push(v.transmission);
        if (v.fuelType) specParts.push(v.fuelType);
        specs.textContent = specParts.length ? specParts.join(" • ") : "Specs available on request";

        const pr = document.createElement("div");
        pr.className = "priceRow";

        const price = document.createElement("div");
        price.className = "price";
        price.textContent = money(v.price);

        const st = document.createElement("div");
        st.className = "status " + ((status==="published" || status==="available" || status==="in_stock" || status==="instock") ? "published" : "");
        st.textContent =
          (status==="published" || status==="available" || status==="in_stock" || status==="instock")
            ? "IN STOCK"
            : (v.status || "Draft");

        pr.appendChild(price);
        pr.appendChild(st);

        const actions = document.createElement("div");
        actions.className = "actions";

        const makeRequest = document.createElement("button");
        makeRequest.className = "btn btn-primary";
        makeRequest.type = "button";
        makeRequest.textContent = "Make Request";

        const panel = document.createElement("div");
        panel.className = "actionPanel";

        const waBtn = document.createElement("button");
        waBtn.className = "btn btn-ghost btn-sm";
        waBtn.type = "button";
        waBtn.textContent = "WhatsApp chat request";
        waBtn.onclick = () => {
          const link = buildWhatsAppLink(title, vehicleId);
          window.open(link, "_blank", "noopener");
        };

        const liveBtn = document.createElement("button");
        liveBtn.className = "btn btn-sm";
        liveBtn.type = "button";
        liveBtn.textContent = "Live Video Viewing";
        liveBtn.onclick = () => openBooking("live_video", dealerId, vehicleId, title);

        const walkBtn = document.createElement("button");
        walkBtn.className = "btn btn-outline btn-sm";
        walkBtn.type = "button";
        walkBtn.textContent = "Book a Walk-In";
        walkBtn.onclick = () => openBooking("walk_in", dealerId, vehicleId, title);

        panel.appendChild(waBtn);
        panel.appendChild(liveBtn);
        panel.appendChild(walkBtn);

        makeRequest.onclick = () => {
          const isOpen = panel.classList.contains("show");
          document.querySelectorAll(".actionPanel").forEach((el) => el.classList.remove("show"));
          if (!isOpen) panel.classList.add("show");
        };

        actions.appendChild(makeRequest);
        actions.appendChild(panel);

        c.appendChild(t);
        c.appendChild(meta);
        c.appendChild(specs);
        c.appendChild(pr);

        const micro = document.createElement("div");
        micro.className = "meta";
        micro.style.fontSize = "11.5px";
        micro.style.color = "var(--muted2)";
        micro.textContent = "Requests are fast and non-binding. We confirm the time with you.";
        c.appendChild(micro);

        c.appendChild(actions);

        card.appendChild(media);
        card.appendChild(c);

        grid.appendChild(card);
      });
    }

    // --------- Booking funnel ----------
    function openBooking(type, dealerId, vehicleId, title){
      booking = { dealerId, vehicleId, title, dealerName: dealerProfile?.name || "" };
      qs("mType").value = type;
      qs("mTitle").textContent = type==="live_video" ? "Book a live video viewing" : "Book a walk-in";
      qs("mSub").textContent =
        type==="live_video"
          ? "Get a live video tour — we’ll answer questions in real time."
          : "Visit in person — choose a time and we’ll confirm.";
      qs("mStatus").textContent = "";
      qs("backdrop").style.display = "flex";
      qs("backdrop").setAttribute("aria-hidden","false");
    }

    function closeBooking(){
      qs("backdrop").style.display = "none";
      qs("backdrop").setAttribute("aria-hidden","true");
    }

    async function submitBooking(){
      const payload = {
        dealerId: booking.dealerId,
        vehicleId: booking.vehicleId,
        vehicleTitle: booking.title,
        type: qs("mType").value,
        name: qs("mName").value.trim(),
        phone: qs("mPhone").value.trim(),
        email: qs("mEmail").value.trim(),
        preferredDate: qs("mDate").value || "",
        preferredTime: qs("mTime").value || "",
        notes: qs("mNotes").value.trim(),
        source: "storefront"
      };

      if (!payload.name || !payload.phone){
        qs("mStatus").textContent = "Please enter your name and phone number.";
        return;
      }

      qs("mStatus").textContent = "Sending request…";

      try{
        const res = await fetch("/api/public/leads", {
          method:"POST",
          headers:{ "Content-Type":"application/json" },
          body: JSON.stringify(payload)
        });
        const data = await res.json().catch(()=>null);

        if (!res.ok){
          qs("mStatus").textContent = data?.error || "Could not send request.";
          showToast("Request not sent.", false);
          return;
        }

        qs("mStatus").textContent = "Request sent. We’ll confirm shortly.";
        showToast("Viewing request sent.");
        setTimeout(closeBooking, 600);
      }catch(e){
        qs("mStatus").textContent = "Could not send request. Please try again.";
        showToast("Request not sent.", false);
      }
    }

    // --------- Wire UI ----------
    qs("btnRefresh").onclick = loadInventory;
    qs("btnApply").onclick = applyFilters;
    qs("btnClear").onclick = ()=>{
      qs("fSearch").value = "";
      qs("fMake").value = "";
      qs("fModel").value = "";
      qs("fYear").value = "";
      qs("fSort").value = "newest";
      applyFilters();
    };

    qs("fSearch").addEventListener("keydown", (e)=>{ if(e.key==="Enter") applyFilters(); });
    qs("fMake").onchange = applyFilters;
    qs("fModel").onchange = applyFilters;
    qs("fYear").onchange = applyFilters;
    qs("fSort").onchange = applyFilters;

    qs("mClose").onclick = closeBooking;
    qs("mCancel").onclick = closeBooking;
    qs("backdrop").addEventListener("click",(e)=>{ if(e.target.id==="backdrop") closeBooking(); });
    qs("mSubmit").onclick = submitBooking;
    document.addEventListener("click", (e)=>{
      if (!e.target.closest(".actions")) {
        document.querySelectorAll(".actionPanel").forEach((el) => el.classList.remove("show"));
      }
    });

    // Boot
    (async ()=>{
      parseVehicleFromUrl();
      await loadConfig(); // not strictly required; kept for future enhancements
      await loadDealerProfile();
      loadInventory();
      setInterval(rotateTip, 5200);
    })();
