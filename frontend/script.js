const API_BASE = "http://localhost:5000/api";

// ---------------------------------------------------------------------------
// Motion system — scroll reveal, navbar shadow, and small animation helpers.
// Pure CSS transitions + IntersectionObserver, no animation library.
// Respects prefers-reduced-motion (handled in CSS; JS just skips delays).
// ---------------------------------------------------------------------------
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function initScrollReveal() {
  const targets = document.querySelectorAll(".reveal, .reveal-child");
  if (!targets.length) return;

  if (prefersReducedMotion || !("IntersectionObserver" in window)) {
    targets.forEach(el => el.classList.add("in-view"));
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add("in-view");
        observer.unobserve(entry.target); // animate once per section
      }
    });
  }, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" });

  targets.forEach(el => observer.observe(el));
}

function initNavbarScrollShadow() {
  const topbar = document.querySelector(".topbar");
  if (!topbar) return;
  const onScroll = () => {
    topbar.classList.toggle("scrolled", window.scrollY > 8);
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
}

// Cycles a status element through a list of phrases while an async task runs.
// Returns a stop() function — call it once the real result is ready.
function startAiStatusCycle(el, phrases, intervalMs = 900) {
  el.innerHTML = `<span class="ai-processing"><span class="ai-ring"></span><span class="ai-status-text">${phrases[0]}</span></span>`;
  let i = 0;
  const textEl = el.querySelector(".ai-status-text");
  const timer = prefersReducedMotion ? null : setInterval(() => {
    i = (i + 1) % phrases.length;
    if (textEl) {
      textEl.style.opacity = "0";
      setTimeout(() => {
        textEl.textContent = phrases[i];
        textEl.style.opacity = "1";
      }, 120);
    }
  }, intervalMs);
  return () => { if (timer) clearInterval(timer); };
}

// Briefly shows a checkmark + message in a status element after success.
function showSuccessStatus(el, message) {
  el.classList.remove("error");
  el.innerHTML = `<span class="success-check">✓</span>${message}`;
}

// Adds a subtle error nudge to a field, auto-clearing on next focus/input.
function flagFieldError(fieldEl) {
  if (!fieldEl) return;
  fieldEl.classList.remove("field-error");
  // force reflow so the animation can replay if triggered twice in a row
  void fieldEl.offsetWidth;
  fieldEl.classList.add("field-error");
  const clear = () => { fieldEl.classList.remove("field-error"); fieldEl.removeEventListener("input", clear); };
  fieldEl.addEventListener("input", clear, { once: true });
}

function renderSkeletonCards(container, count = 3) {
  container.innerHTML = Array.from({ length: count }).map(() => `
    <div class="skeleton-card">
      <div class="skeleton-line w-40"></div>
      <div class="skeleton-line w-full"></div>
      <div class="skeleton-line w-60"></div>
    </div>
  `).join("");
}

// ---------------------------------------------------------------------------
// Auth — token stored in localStorage; sent as "Authorization: Bearer <token>"
// on requests that support it. Endpoints work fine without login too
// (guest mode), auth just unlocks saved plan/history state.
// ---------------------------------------------------------------------------
let authToken = localStorage.getItem("signal_token") || null;
let currentUser = null; // { id, name, email, plan }

function authHeaders() {
  return authToken ? { "Authorization": `Bearer ${authToken}` } : {};
}

function setSession(token, user) {
  authToken = token;
  currentUser = user;
  localStorage.setItem("signal_token", token);
  renderAuthArea();
}

function clearSession() {
  authToken = null;
  currentUser = null;
  savedJobIds = new Set();
  localStorage.removeItem("signal_token");
  renderAuthArea();
  closeDashboardModal();
}

const authArea = document.getElementById("authArea");
const loginNavBtn = document.getElementById("loginNavBtn");
const signupNavBtn = document.getElementById("signupNavBtn");

function renderAuthArea() {
  if (!currentUser) {
    authArea.innerHTML = "";
    authArea.appendChild(loginNavBtn);
    authArea.appendChild(signupNavBtn);
    return;
  }
  const plan = currentUser.plan || "free";
  authArea.innerHTML = `
    <button type="button" class="nav-btn ghost" id="dashboardNavBtn">📊 Dashboard</button>
    <div class="user-chip">
      <span>${escapeHtml(currentUser.name)}</span>
      <span class="plan-badge ${plan === "pro" ? "pro" : ""}">${plan}</span>
    </div>
    <button type="button" class="nav-btn ghost" id="logoutBtn">Log out</button>
  `;
  document.getElementById("dashboardNavBtn").addEventListener("click", openDashboardModal);
  document.getElementById("logoutBtn").addEventListener("click", () => {
    clearSession();
    updatePricingUI();
    if (lastResumeId) fetchAndRenderMatches(lastResumeId);
  });
}

async function fetchCurrentUser() {
  if (!authToken) return;
  try {
    const res = await fetch(`${API_BASE}/auth/me`, { headers: authHeaders() });
    if (!res.ok) { clearSession(); return; }
    currentUser = await res.json();
    renderAuthArea();
    updatePricingUI();
    refreshSavedJobIds();
    refreshDashboard();
  } catch (err) {
    console.error(err);
  }
}

// --- Dashboard modal (Resume Score / Jobs Matched / Saved / Applications / Interviews) ---
const dashboardModal = document.getElementById("dashboardModal");
const dashboardModalClose = document.getElementById("dashboardModalClose");
const dashboardName = document.getElementById("dashboardName");

function openDashboardModal() {
  if (!currentUser) {
    openAuthModal("login");
    return;
  }
  dashboardModal.hidden = false;
  refreshDashboard();
}
function closeDashboardModal() {
  dashboardModal.hidden = true;
}
dashboardModalClose.addEventListener("click", closeDashboardModal);
dashboardModal.addEventListener("click", (e) => { if (e.target === dashboardModal) closeDashboardModal(); });

async function refreshDashboard() {
  if (!authToken || !currentUser) return;
  try {
    const res = await fetch(`${API_BASE}/dashboard`, { headers: authHeaders() });
    if (!res.ok) return;
    const data = await res.json();

    dashboardName.textContent = `, ${currentUser.name.split(" ")[0]}`;

    const resumeScoreEl = document.getElementById("statResumeScore");
    resumeScoreEl.innerHTML = `<span class="count-target">0</span><small>/100</small>`;
    animateCountUp(resumeScoreEl.querySelector(".count-target"), data.resume_score, "");

    animateCountUp(document.getElementById("statJobsMatched"), data.jobs_matched, "");
    animateCountUp(document.getElementById("statSavedJobs"), data.saved_jobs, "");
    animateCountUp(document.getElementById("statApplications"), data.applications, "");
    animateCountUp(document.getElementById("statInterviews"), data.interviews, "");

    refreshResumeHistory();
    refreshApplicationTracker();
  } catch (err) {
    console.error(err);
  }
}

function lockedTeaserRow(message) {
  return `
    <div class="locked-teaser-row">
      <span>🔒 ${escapeHtml(message)}</span>
      <button type="button" class="secondary-btn upgrade-inline-btn">Upgrade to Pro</button>
    </div>
  `;
}

function wireUpgradeButtons(container) {
  container.querySelectorAll(".upgrade-inline-btn").forEach(btn => {
    btn.addEventListener("click", () => document.querySelector(".pricing")?.scrollIntoView({ behavior: "smooth" }));
  });
}

async function refreshResumeHistory() {
  const el = document.getElementById("resumeHistoryList");
  if (!authToken) return;
  try {
    const res = await fetch(`${API_BASE}/resumes`, { headers: authHeaders() });
    const data = await res.json();
    if (!res.ok) { el.innerHTML = ""; return; }

    if (!data.resumes.length) {
      el.innerHTML = `<p class="empty-state" style="margin:0;">No resumes saved yet — scan one above or use "Save to My Resumes" in the builder.</p>`;
      return;
    }
    const rows = data.resumes.map(r => `
      <div class="history-row" data-resume-id="${r.id}">
        <div class="history-row-main">
          <span class="history-row-name">${escapeHtml(r.filename)}</span>
          <span class="history-row-meta">${r.skill_count} skills · ${new Date(r.uploaded_at.replace(" ", "T") + "Z").toLocaleDateString()}</span>
        </div>
        <div class="history-row-actions">
          <button type="button" class="icon-btn download-resume-btn" data-id="${r.id}" data-filename="${escapeHtml(r.filename)}" title="Download">⬇</button>
          <button type="button" class="icon-btn delete-resume-btn" data-id="${r.id}" title="Delete">✕</button>
        </div>
      </div>
    `).join("");
    const teaser = data.plan_limited
      ? lockedTeaserRow(`${data.locked_count} more resume${data.locked_count === 1 ? "" : "s"} in your history — Pro shows unlimited resume history.`)
      : "";
    el.innerHTML = rows + teaser;
    wireUpgradeButtons(el);

    el.querySelectorAll(".download-resume-btn").forEach(btn => {
      btn.addEventListener("click", () => downloadSavedResume(Number(btn.dataset.id), btn.dataset.filename));
    });
    el.querySelectorAll(".delete-resume-btn").forEach(btn => {
      btn.addEventListener("click", () => deleteSavedResume(Number(btn.dataset.id)));
    });
  } catch (err) {
    console.error(err);
  }
}

async function downloadSavedResume(id, filename) {
  try {
    const res = await fetch(`${API_BASE}/resumes/${id}/download`, { headers: authHeaders() });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (isProRequiredResponse(data)) {
        alert(data.message); // brief, blocking — this is an edge case (an id that scrolled out of view mid-session)
      }
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || `resume-${id}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error(err);
  }
}

async function deleteSavedResume(id) {
  const row = document.querySelector(`.history-row[data-resume-id="${id}"]`);
  try {
    const res = await fetch(`${API_BASE}/resumes/${id}`, { method: "DELETE", headers: authHeaders() });
    if (!res.ok) return;
    if (row && !prefersReducedMotion) {
      row.classList.add("removing");
      row.addEventListener("transitionend", () => { refreshResumeHistory(); refreshDashboard(); }, { once: true });
      setTimeout(() => { refreshResumeHistory(); refreshDashboard(); }, 400);
    } else {
      refreshResumeHistory();
      refreshDashboard();
    }
  } catch (err) {
    console.error(err);
  }
}

const APPLICATION_STATUS_LABELS = {
  saved: "Saved", applied: "Applied", screening: "Screening",
  interview: "Interview", offer: "Offer", rejected: "Rejected",
};

async function refreshApplicationTracker() {
  const el = document.getElementById("applicationTrackerList");
  if (!authToken) return;
  try {
    const res = await fetch(`${API_BASE}/applications`, { headers: authHeaders() });
    const data = await res.json();

    if (!res.ok && isProRequiredResponse(data)) {
      el.innerHTML = lockedTeaserRow(data.message);
      wireUpgradeButtons(el);
      return;
    }
    if (!res.ok) { el.innerHTML = ""; return; }

    if (!data.length) {
      el.innerHTML = `<p class="empty-state" style="margin:0;">No applications tracked yet — use "Track application" on a job match.</p>`;
      return;
    }
    el.innerHTML = data.map(a => `
      <div class="history-row">
        <span class="history-row-name">${a.logo_emoji || "🏢"} ${escapeHtml(a.title)} · ${escapeHtml(a.company)}</span>
        <span class="status-pill status-${a.status}">${APPLICATION_STATUS_LABELS[a.status] || a.status}</span>
      </div>
    `).join("");
  } catch (err) {
    console.error(err);
  }
}

async function refreshSavedJobIds() {
  if (!authToken) { savedJobIds = new Set(); return; }
  try {
    const res = await fetch(`${API_BASE}/saved-jobs`, { headers: authHeaders() });
    if (!res.ok) return;
    const rows = await res.json();
    savedJobIds = new Set(rows.map(r => r.job_id));
  } catch (err) {
    console.error(err);
  }
}

// --- Auth modal ---
const authModal = document.getElementById("authModal");
const authModalClose = document.getElementById("authModalClose");
const loginPane = document.getElementById("loginPane");
const signupPane = document.getElementById("signupPane");

function openAuthModal(mode) {
  authModal.hidden = false;
  loginPane.hidden = mode !== "login";
  signupPane.hidden = mode !== "signup";
}
function closeAuthModal() {
  authModal.hidden = true;
}

loginNavBtn.addEventListener("click", () => openAuthModal("login"));
signupNavBtn.addEventListener("click", () => openAuthModal("signup"));
authModalClose.addEventListener("click", closeAuthModal);
authModal.addEventListener("click", (e) => { if (e.target === authModal) closeAuthModal(); });

document.getElementById("switchToSignup").addEventListener("click", () => openAuthModal("signup"));
document.getElementById("switchToLogin").addEventListener("click", () => openAuthModal("login"));

const loginStatus = document.getElementById("loginStatus");
const signupStatus = document.getElementById("signupStatus");

document.getElementById("loginSubmitBtn").addEventListener("click", async () => {
  const email = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;
  if (!email || !password) {
    loginStatus.textContent = "Enter your email and password.";
    loginStatus.classList.add("error");
    return;
  }
  loginStatus.classList.remove("error");
  loginStatus.textContent = "Logging in...";
  try {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Login failed");
    setSession(data.token, data.user);
    closeAuthModal();
    loginStatus.textContent = "";
    updatePricingUI();
    refreshSavedJobIds();
    refreshDashboard();
    if (lastResumeId) fetchAndRenderMatches(lastResumeId); // re-fetch so Pro unlock reflects immediately
  } catch (err) {
    loginStatus.textContent = err.message;
    loginStatus.classList.add("error");
  }
});

document.getElementById("signupSubmitBtn").addEventListener("click", async () => {
  const name = document.getElementById("signupName").value.trim();
  const email = document.getElementById("signupEmail").value.trim();
  const password = document.getElementById("signupPassword").value;
  if (!name || !email || !password) {
    signupStatus.textContent = "Fill in all fields.";
    signupStatus.classList.add("error");
    return;
  }
  signupStatus.classList.remove("error");
  signupStatus.textContent = "Creating account...";
  try {
    const res = await fetch(`${API_BASE}/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Sign up failed");
    setSession(data.token, data.user);
    closeAuthModal();
    signupStatus.textContent = "";
    updatePricingUI();
    refreshSavedJobIds();
    refreshDashboard();
    if (lastResumeId) fetchAndRenderMatches(lastResumeId);
  } catch (err) {
    signupStatus.textContent = err.message;
    signupStatus.classList.add("error");
  }
});

// --- Pricing / mock subscription ---
const pricingStatus = document.getElementById("pricingStatus");

function updatePricingUI() {
  const plan = currentUser ? (currentUser.plan || "free") : "free";
  document.querySelectorAll(".subscribe-btn").forEach(btn => {
    const btnPlan = btn.dataset.plan;
    if (btnPlan === plan) {
      btn.textContent = "Current plan";
      btn.disabled = true;
    } else if (btnPlan === "pro") {
      btn.textContent = "Upgrade to Pro";
      btn.disabled = false;
    } else {
      btn.textContent = "Downgrade to Free";
      btn.disabled = false;
    }
  });
}

document.querySelectorAll(".subscribe-btn").forEach(btn => {
  btn.addEventListener("click", async () => {
    if (!currentUser) {
      pricingStatus.classList.remove("error");
      pricingStatus.textContent = "Please log in first to choose a plan.";
      openAuthModal("login");
      return;
    }
    const plan = btn.dataset.plan;
    pricingStatus.classList.remove("error");
    pricingStatus.textContent = "Processing (mock checkout)...";
    try {
      const res = await fetch(`${API_BASE}/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ plan }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not update plan");
      currentUser.plan = data.plan;
      renderAuthArea();
      updatePricingUI();
      refreshDashboard();
      refreshSavedJobIds();
      if (lastResumeId) fetchAndRenderMatches(lastResumeId); // reflect the new plan's breakdown/limits immediately
      pricingStatus.textContent = data.message || `You're now on the ${plan} plan.`;
    } catch (err) {
      pricingStatus.textContent = err.message;
      pricingStatus.classList.add("error");
    }
  });
});

// init
renderAuthArea();
fetchCurrentUser();
updatePricingUI();
initScrollReveal();
initNavbarScrollShadow();

// ---------------------------------------------------------------------------
// Resume scanner
// ---------------------------------------------------------------------------
const resumeText = document.getElementById("resumeText");
const filenameInput = document.getElementById("filename");
const scanBtn = document.getElementById("scanBtn");
const statusMsg = document.getElementById("statusMsg");
const resultsSection = document.getElementById("resultsSection");
const skillTagsEl = document.getElementById("skillTags");
const matchListEl = document.getElementById("matchList");

function renderSkillTags(skills) {
  skillTagsEl.innerHTML = skills.length
    ? skills.map(s => `<span class="skill-tag">${s}</span>`).join("")
    : `<span class="status-msg">No known skills detected — try adding more detail.</span>`;
}

function formatSalary(job) {
  if (!job.salary_min && !job.salary_max) return "";
  const cur = job.currency || "MYR";
  if (job.salary_min && job.salary_max) return `${cur} ${job.salary_min.toLocaleString()}–${job.salary_max.toLocaleString()}`;
  return `${cur} ${(job.salary_min || job.salary_max).toLocaleString()}+`;
}

function renderMatches(results) {
  matchListEl.innerHTML = results.map((r, i) => {
    const salary = formatSalary(r);
    const metaBits = [r.company, r.location, salary, r.employment_type].filter(Boolean).map(escapeHtml).join(" · ");
    const isSaved = savedJobIds.has(r.job_id);

    const breakdownHtml = r.breakdown ? `
      <div class="match-breakdown">
        <div class="breakdown-row">
          <span>Skill Match</span>
          <div class="meter"><div class="meter-fill" data-width="${r.breakdown.skill_match}"></div></div>
          <span class="breakdown-pct">${r.breakdown.skill_match}%</span>
        </div>
        <div class="breakdown-row">
          <span>Domain Match</span>
          <div class="meter"><div class="meter-fill" data-width="${r.breakdown.domain_match}"></div></div>
          <span class="breakdown-pct">${r.breakdown.domain_match}%</span>
        </div>
      </div>
    ` : `
      <div class="pro-lock-banner">
        <span>🔒 <strong>PRO</strong> — Unlock the full Skill &amp; Domain Match breakdown and complete skill-gap list.</span>
        <button type="button" class="secondary-btn upgrade-inline-btn">Upgrade to Pro</button>
      </div>
    `;

    return `
    <div class="match-card" style="--card-delay: ${prefersReducedMotion ? 0 : Math.min(i * 60, 300)}ms" data-job-id="${r.job_id}">
      <div class="match-card-top">
        <div>
          <div class="match-title">${r.logo_emoji ? r.logo_emoji + " " : ""}${escapeHtml(r.title)}</div>
          ${metaBits ? `<div class="match-company">${metaBits}</div>` : ""}
        </div>
        <div class="match-score" data-target="${r.score}">0%</div>
      </div>
      <div class="meter meter-overall"><div class="meter-fill" data-width="${r.score}"></div></div>

      ${breakdownHtml}

      <div class="match-cols">
        <div class="match-col">
          <p class="match-col-title">Why you match</p>
          ${r.matched_skills.length ? `<ul class="why-match-list">${r.matched_skills.map(s => `<li>✓ ${escapeHtml(s)}</li>`).join("")}</ul>` : `<p class="empty-state" style="margin:0;">No exact skill matches yet.</p>`}
        </div>
        <div class="match-col">
          <p class="match-col-title">Skill gaps</p>
          ${r.missing_skills.length ? `<ul class="skill-gap-list">${r.missing_skills.map(s => `<li>⚠ ${escapeHtml(s)}</li>`).join("")}</ul>` : `<p class="empty-state" style="margin:0;">No major gaps detected.</p>`}
        </div>
      </div>

      <p class="recommendation-line"><strong>Recommendation:</strong> ${escapeHtml(r.recommendation || "")}</p>

      <div class="match-card-actions">
        <button type="button" class="secondary-btn save-job-btn ${isSaved ? "is-saved" : ""}" data-job-id="${r.job_id}">${isSaved ? "✓ Saved" : "☆ Save job"}</button>
        ${r.application_url
          ? `<a class="secondary-btn" href="${r.application_url}" target="_blank" rel="noopener">Apply ↗</a>`
          : `<button type="button" class="secondary-btn track-application-btn" data-job-id="${r.job_id}">Track application</button>`}
      </div>
    </div>
  `;
  }).join("");

  // animate meters + score count-up in after paint
  requestAnimationFrame(() => {
    document.querySelectorAll(".meter-fill").forEach(el => {
      el.style.width = el.dataset.width + "%";
    });
    document.querySelectorAll(".match-score").forEach(el => animateCountUp(el, Number(el.dataset.target), "%"));
  });

  matchListEl.querySelectorAll(".save-job-btn").forEach(btn => {
    btn.addEventListener("click", () => toggleSaveJob(Number(btn.dataset.jobId), btn));
  });
  matchListEl.querySelectorAll(".track-application-btn").forEach(btn => {
    btn.addEventListener("click", () => trackApplication(Number(btn.dataset.jobId), btn));
  });
  matchListEl.querySelectorAll(".upgrade-inline-btn").forEach(btn => {
    btn.addEventListener("click", () => document.querySelector(".pricing")?.scrollIntoView({ behavior: "smooth" }));
  });
}

// Animates a number counting up — used for match scores and dashboard tiles.
function animateCountUp(el, target, suffix = "") {
  if (prefersReducedMotion) { el.textContent = target + suffix; return; }
  const duration = 700;
  const start = performance.now();
  function tick(now) {
    const progress = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = Math.round(target * eased) + suffix;
    if (progress < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// --- Save job / track application ---
let savedJobIds = new Set();

async function toggleSaveJob(jobId, btn) {
  if (!currentUser) {
    openAuthModal("login");
    return;
  }
  const alreadySaved = savedJobIds.has(jobId);
  btn.disabled = true;
  try {
    if (alreadySaved) {
      const res = await fetch(`${API_BASE}/saved-jobs/${jobId}`, { method: "DELETE", headers: authHeaders() });
      if (res.ok) {
        savedJobIds.delete(jobId);
        btn.textContent = "☆ Save job";
        btn.classList.remove("is-saved");
        refreshDashboard();
      }
    } else {
      const res = await fetch(`${API_BASE}/saved-jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ job_id: jobId }),
      });
      const data = await res.json();
      if (res.ok) {
        savedJobIds.add(jobId);
        btn.textContent = "✓ Saved";
        btn.classList.add("is-saved");
        refreshDashboard();
      } else if (isProRequiredResponse(data)) {
        flashProLockButton(btn, data.message);
      }
    }
  } catch (err) {
    console.error(err);
  } finally {
    btn.disabled = false;
  }
}

async function trackApplication(jobId, btn) {
  if (!currentUser) {
    openAuthModal("login");
    return;
  }
  btn.disabled = true;
  const original = btn.textContent;
  try {
    const res = await fetch(`${API_BASE}/applications`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ job_id: jobId, status: "applied" }),
    });
    const data = await res.json();
    if (res.ok) {
      btn.textContent = "✓ Tracked";
      refreshDashboard();
      setTimeout(() => { btn.disabled = false; }, 800);
    } else if (isProRequiredResponse(data)) {
      flashProLockButton(btn, data.message);
      btn.disabled = false;
    } else {
      btn.textContent = original;
      btn.disabled = false;
    }
  } catch (err) {
    console.error(err);
    btn.textContent = original;
    btn.disabled = false;
  }
}

let lastMatchResults = [];
let lastResumeId = null;

async function fetchAndRenderMatches(resumeId) {
  lastResumeId = resumeId;
  const matchRes = await fetch(`${API_BASE}/match/${resumeId}`, { headers: authHeaders() });
  const matchData = await matchRes.json();

  if (matchRes.status === 429 && isProRequiredResponse(matchData)) {
    // Free-plan refresh cooldown: don't blow away whatever's already on
    // screen (e.g. from a login/logout auto-refresh) — just report it so
    // the caller can decide whether to surface it.
    return { cooldown: true, message: matchData.message };
  }
  if (!matchRes.ok) throw new Error(matchData.message || matchData.error || "Match failed");

  renderSkillTags(matchData.resume_skills);
  renderMatches(matchData.results);
  lastMatchResults = matchData.results;
  resultsSection.hidden = false;
  resultsSection.classList.add("in-view"); // was hidden at observer-init time, so reveal manually
  resultsSection.scrollIntoView({ behavior: "smooth" });
  return matchData;
}

async function runScan() {
  const text = resumeText.value.trim();
  if (!text) {
    statusMsg.textContent = "Paste some resume text first.";
    statusMsg.classList.add("error");
    flagFieldError(resumeText);
    return;
  }

  statusMsg.classList.remove("error");
  scanBtn.disabled = true;

  // Show the AI status cycle in the status line, and skeleton cards where
  // the results will appear, so the wait feels active rather than frozen.
  const stopStatusCycle = startAiStatusCycle(statusMsg, [
    "Analyzing resume...", "Matching skills...", "Comparing experience...", "Preparing results...",
  ]);
  resultsSection.hidden = false;
  resultsSection.classList.add("in-view");
  renderSkeletonCards(matchListEl, 3);
  skillTagsEl.innerHTML = "";

  try {
    const uploadRes = await fetch(`${API_BASE}/resumes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        filename: filenameInput.value.trim() || "resume.txt",
        text,
      }),
    });
    const uploadData = await uploadRes.json();
    if (!uploadRes.ok) throw new Error(uploadData.error || "Upload failed");

    const matchData = await fetchAndRenderMatches(uploadData.id);
    stopStatusCycle();
    if (matchData.cooldown) {
      showProLockStatus(statusMsg, matchData.message);
    } else {
      showSuccessStatus(statusMsg, `Scan complete — ${matchData.results.length} channels checked.`);
    }
  } catch (err) {
    console.error(err);
    stopStatusCycle();
    statusMsg.textContent = "Something went wrong — is the backend running on :5000?";
    statusMsg.classList.add("error");
  } finally {
    scanBtn.disabled = false;
  }
}

scanBtn.addEventListener("click", runScan);

// --- Upload an existing resume file (.txt / .pdf / .docx) ---
const resumeFileInput = document.getElementById("resumeFileInput");
const fileUploadStatus = document.getElementById("fileUploadStatus");

async function uploadResumeFile(file) {
  fileUploadStatus.classList.remove("error");
  const stopStatusCycle = startAiStatusCycle(fileUploadStatus, [
    `Reading ${file.name}...`, "Extracting text...", "Analyzing resume...",
  ]);

  const formData = new FormData();
  formData.append("file", file);

  try {
    const res = await fetch(`${API_BASE}/resumes/upload-file`, {
      method: "POST",
      headers: { ...authHeaders() },
      body: formData,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Upload failed");

    resumeText.value = data.text;
    filenameInput.value = data.filename;

    const matchData = await fetchAndRenderMatches(data.id);
    stopStatusCycle();
    if (matchData.cooldown) {
      showProLockStatus(fileUploadStatus, matchData.message);
    } else {
      showSuccessStatus(fileUploadStatus, `Loaded ${data.filename} — ${matchData.results.length} channels checked.`);
    }
  } catch (err) {
    console.error(err);
    stopStatusCycle();
    fileUploadStatus.textContent = err.message || "Could not read that file.";
    fileUploadStatus.classList.add("error");
  }
}

resumeFileInput.addEventListener("change", () => {
  const file = resumeFileInput.files[0];
  if (file) uploadResumeFile(file);
});

// ---------------------------------------------------------------------------
// Resume Builder
// ---------------------------------------------------------------------------
const experienceList = document.getElementById("experienceList");
const educationList = document.getElementById("educationList");
const addExperienceBtn = document.getElementById("addExperienceBtn");
const addEducationBtn = document.getElementById("addEducationBtn");
const generateBtn = document.getElementById("generateBtn");
const builderStatus = document.getElementById("builderStatus");
const generatedPreview = document.getElementById("generatedPreview");
const resumeVisual = document.getElementById("resumeVisual");
const useForScanBtn = document.getElementById("useForScanBtn");
const saveToHistoryBtn = document.getElementById("saveToHistoryBtn");
const saveToHistoryStatus = document.getElementById("saveToHistoryStatus");
const downloadPdfBtn = document.getElementById("downloadPdfBtn");
const downloadBtn = document.getElementById("downloadBtn");
const bPhoto = document.getElementById("bPhoto");
const photoPreview = document.getElementById("photoPreview");
const removePhotoBtn = document.getElementById("removePhotoBtn");
const templatePicker = document.getElementById("templatePicker");

let photoDataUrl = null;
let selectedTemplate = "minimal";
let lastPlainText = "";

const experienceEmpty = document.getElementById("experienceEmpty");
const educationEmpty = document.getElementById("educationEmpty");
const progressFill = document.getElementById("progressFill");
const progressLabel = document.getElementById("progressLabel");

function getBuilderFieldValues() {
  return {
    fullName: document.getElementById("bFullName").value.trim(),
    email: document.getElementById("bEmail").value.trim(),
    phone: document.getElementById("bPhone").value.trim(),
    targetRole: document.getElementById("bTargetRole").value.trim(),
    summary: document.getElementById("bSummary").value.trim(),
    skills: document.getElementById("bSkills").value.split(",").map(s => s.trim()).filter(Boolean),
    experience: collectEntries(experienceList),
    education: collectEntries(educationList),
  };
}

// --- Live preview: re-renders the visual panel from current form state.
// Debounced on text input so fast typing doesn't thrash the DOM. ---
let previewDebounceTimer = null;
function scheduleLivePreviewUpdate() {
  clearTimeout(previewDebounceTimer);
  previewDebounceTimer = setTimeout(updateLivePreview, prefersReducedMotion ? 0 : 150);
}

function updateLivePreview() {
  const data = getBuilderFieldValues();
  const hasAnyContent = data.fullName || data.email || data.phone || data.summary ||
    data.skills.length || data.experience.some(e => e.title || e.company) ||
    data.education.some(e => e.degree || e.school);

  if (!hasAnyContent) {
    resumeVisual.innerHTML = `<div class="preview-placeholder">Start filling the form on the left — your resume builds itself here.</div>`;
  } else {
    resumeVisual.innerHTML = renderResumeVisual(selectedTemplate, { ...data, photoDataUrl });
  }
  updateBuilderProgress(data);
}

function updateBuilderProgress(data) {
  const checks = [
    !!data.fullName,
    !!(data.email || data.phone),
    !!data.summary,
    data.skills.length > 0,
    data.experience.some(e => e.title || e.company),
    data.education.some(e => e.degree || e.school),
  ];
  const done = checks.filter(Boolean).length;
  const percent = Math.round((done / checks.length) * 100);
  progressFill.style.width = percent + "%";
  progressLabel.textContent = `${percent}% complete`;
}

function updateEmptyStates() {
  experienceEmpty.hidden = experienceList.querySelectorAll(".entry-row").length > 0;
  educationEmpty.hidden = educationList.querySelectorAll(".entry-row").length > 0;
}

// --- Photo upload ---
bPhoto.addEventListener("change", () => {
  const file = bPhoto.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    photoDataUrl = reader.result;
    photoPreview.innerHTML = `<img src="${photoDataUrl}" alt="Your photo">`;
    updateLivePreview();
  };
  reader.readAsDataURL(file);
});

removePhotoBtn.addEventListener("click", () => {
  const img = photoPreview.querySelector("img");
  photoDataUrl = null;
  bPhoto.value = "";
  if (img && !prefersReducedMotion) {
    img.classList.add("photo-leaving");
    img.addEventListener("animationend", () => { photoPreview.innerHTML = "No photo"; }, { once: true });
  } else {
    photoPreview.innerHTML = "No photo";
  }
  updateLivePreview();
});

// --- Template picker (buttons, so this also covers keyboard activation) ---
templatePicker.querySelectorAll(".template-option").forEach(opt => {
  opt.addEventListener("click", () => {
    templatePicker.querySelectorAll(".template-option").forEach(o => {
      o.classList.remove("selected");
      o.setAttribute("aria-checked", "false");
    });
    opt.classList.add("selected");
    opt.setAttribute("aria-checked", "true");
    selectedTemplate = opt.dataset.template;
    updateLivePreview();
  });
});

// --- Experience / education rows ---
// Animates a row out (fade + slide up) before removing it from the DOM,
// so add/remove never breaks the underlying collectEntries() logic.
function removeRowAnimated(row, container) {
  const finish = () => {
    row.remove();
    updateEmptyStates();
    updateLivePreview();
  };
  if (prefersReducedMotion) { finish(); return; }
  row.classList.add("removing");
  row.addEventListener("transitionend", finish, { once: true });
  // safety fallback in case transitionend doesn't fire (e.g. display:none ancestor)
  setTimeout(() => { if (row.isConnected) finish(); }, 400);
}

function addExperienceRow() {
  const row = document.createElement("div");
  row.className = "entry-row";
  row.innerHTML = `
    <input type="text" data-field="title" placeholder="Job title" />
    <input type="text" data-field="company" placeholder="Company" />
    <input type="text" data-field="duration" placeholder="Duration — e.g. Jan 2022 - Present" />
    <input type="text" data-field="location" placeholder="Location (optional)" />
    <textarea data-field="description" placeholder="What did you do? One point per line."></textarea>
    <button type="button" class="remove-entry-btn">Remove ✕</button>
  `;
  row.querySelector(".remove-entry-btn").addEventListener("click", () => removeRowAnimated(row, experienceList));
  experienceList.appendChild(row);
  updateEmptyStates();
}

function addEducationRow() {
  const row = document.createElement("div");
  row.className = "entry-row";
  row.innerHTML = `
    <input type="text" data-field="degree" placeholder="Qualification — e.g. Diploma in IT" />
    <input type="text" data-field="school" placeholder="School / institution" />
    <input type="text" data-field="year" placeholder="Year (optional)" />
    <button type="button" class="remove-entry-btn">Remove ✕</button>
  `;
  row.querySelector(".remove-entry-btn").addEventListener("click", () => removeRowAnimated(row, educationList));
  educationList.appendChild(row);
  updateEmptyStates();
}

function collectEntries(container) {
  const rows = container.querySelectorAll(".entry-row");
  const entries = [];
  rows.forEach(row => {
    const entry = {};
    row.querySelectorAll("[data-field]").forEach(field => {
      entry[field.dataset.field] = field.value.trim();
    });
    entries.push(entry);
  });
  return entries;
}

// ---------------------------------------------------------------------------
// Plan-gated ("pro_required") responses — one consistent handler for every
// endpoint that can return the {error:"pro_required", feature, message}
// shape, so a locked feature always explains itself instead of just failing
// silently or being hidden.
// ---------------------------------------------------------------------------
function isProRequiredResponse(data) {
  return data && data.error === "pro_required";
}

// For status-line elements (chat/builder/pricing/file-upload status text).
function showProLockStatus(statusEl, message) {
  statusEl.classList.remove("error");
  statusEl.innerHTML = `🔒 ${escapeHtml(message)} `;
  const link = document.createElement("button");
  link.type = "button";
  link.className = "secondary-btn upgrade-inline-btn";
  link.textContent = "Upgrade to Pro";
  link.addEventListener("click", () => document.querySelector(".pricing")?.scrollIntoView({ behavior: "smooth" }));
  statusEl.appendChild(link);
}

// For compact contexts (a button inside a match card) — briefly swaps the
// button's label and puts the full explanation in its title tooltip.
function flashProLockButton(btn, message) {
  const original = btn.textContent;
  btn.textContent = "🔒 Pro Feature";
  btn.title = message;
  btn.classList.add("locked-flash");
  setTimeout(() => {
    btn.textContent = original;
    btn.classList.remove("locked-flash");
    btn.title = "";
  }, 3000);
}

// --- Visual template rendering (runs entirely in the browser) ---
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}

function getInitials(name) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  return parts.slice(0, 2).map(p => p[0].toUpperCase()).join("") || "?";
}

function renderResumeVisual(template, data) {
  const validExperience = data.experience.filter(e => e.title || e.company || e.description);
  const validEducation = data.education.filter(e => e.degree || e.school);

  const avatarHtml = data.photoDataUrl
    ? `<img class="r-avatar" src="${data.photoDataUrl}" alt="${escapeHtml(data.fullName)}">`
    : `<div class="r-avatar" style="display:flex;align-items:center;justify-content:center;font-size:1.3rem;font-weight:700;color:#888;">${getInitials(data.fullName)}</div>`;

  const contactInline = [data.email, data.phone].filter(Boolean).map(escapeHtml).join(" · ");
  const contactStacked = [data.email, data.phone].filter(Boolean).map(escapeHtml).join("<br>");
  const skillsHtml = data.skills.map(s => `<span class="r-skill-pill">${escapeHtml(s)}</span>`).join("");

  const experienceHtml = validExperience.map(exp => `
    <div class="r-entry">
      <div class="r-entry-title">${escapeHtml(exp.title)}</div>
      ${exp.duration ? `<div class="r-entry-sub">${escapeHtml(exp.duration)}</div>` : ""}
      ${exp.description ? `<ul>${exp.description.split("\n").filter(l => l.trim()).map(l => `<li>${escapeHtml(l.trim())}</li>`).join("")}</ul>` : ""}
    </div>
  `).join("");

  const educationHtml = validEducation.map(edu => `
    <div class="r-entry">
      <div class="r-entry-title">${escapeHtml(edu.degree)}</div>
      <div class="r-entry-sub">${[edu.school, edu.year].filter(Boolean).map(escapeHtml).join(" · ")}</div>
    </div>
  `).join("");

  if (template === "sidebar") {
    return `
      <div class="resume-doc tpl-sidebar">
        <div class="r-side">
          ${avatarHtml}
          <div class="r-name">${escapeHtml(data.fullName)}</div>
          ${data.targetRole ? `<div class="r-role">${escapeHtml(data.targetRole)}</div>` : ""}
          <div class="r-contact">${contactStacked}</div>
          ${data.skills.length ? `<div class="r-section-title">Skills</div><div>${skillsHtml}</div>` : ""}
          ${validEducation.length ? `<div class="r-section-title">Education</div>${educationHtml}` : ""}
        </div>
        <div class="r-main">
          ${data.summary ? `<div class="r-section-title">Summary</div><p>${escapeHtml(data.summary)}</p>` : ""}
          ${validExperience.length ? `<div class="r-section-title">Experience</div>${experienceHtml}` : ""}
        </div>
      </div>
    `;
  }

  if (template === "bold") {
    return `
      <div class="resume-doc tpl-bold">
        <div class="r-header">
          ${avatarHtml}
          <div>
            <div class="r-name">${escapeHtml(data.fullName)}</div>
            ${data.targetRole ? `<div class="r-role">${escapeHtml(data.targetRole)}</div>` : ""}
            <div class="r-contact">${contactInline}</div>
          </div>
        </div>
        <div class="r-body">
          <div>
            ${data.skills.length ? `<div class="r-section-title">Skills</div><div>${skillsHtml}</div>` : ""}
            ${validEducation.length ? `<div class="r-section-title">Education</div>${educationHtml}` : ""}
          </div>
          <div>
            ${data.summary ? `<div class="r-section-title">Summary</div><p>${escapeHtml(data.summary)}</p>` : ""}
            ${validExperience.length ? `<div class="r-section-title">Experience</div>${experienceHtml}` : ""}
          </div>
        </div>
      </div>
    `;
  }

  // default: minimal
  return `
    <div class="resume-doc tpl-minimal">
      <div class="r-header">
        ${avatarHtml}
        <div class="r-name">${escapeHtml(data.fullName)}</div>
        ${data.targetRole ? `<div class="r-role">${escapeHtml(data.targetRole)}</div>` : ""}
        <div class="r-contact">${contactInline}</div>
      </div>
      ${data.summary ? `<div class="r-section-title">Summary</div><p>${escapeHtml(data.summary)}</p>` : ""}
      ${data.skills.length ? `<div class="r-section-title">Skills</div><div>${skillsHtml}</div>` : ""}
      ${validExperience.length ? `<div class="r-section-title">Experience</div>${experienceHtml}` : ""}
      ${validEducation.length ? `<div class="r-section-title">Education</div>${educationHtml}` : ""}
    </div>
  `;
}

// --- Generate: calls backend for plain text + skill detection.
// The live preview above already mirrors the current data (client-side,
// via updateLivePreview), so this mainly finalizes the downloadable/plain
// text version and unlocks the "use for scan" / download actions. ---
async function generateResume() {
  const fullNameInput = document.getElementById("bFullName");
  const fullName = fullNameInput.value.trim();
  if (!fullName) {
    builderStatus.textContent = "Full name is required.";
    builderStatus.classList.add("error");
    flagFieldError(fullNameInput);
    fullNameInput.focus();
    return;
  }

  builderStatus.classList.remove("error");
  generateBtn.disabled = true;
  generateBtn.classList.add("is-loading");
  const stopStatusCycle = startAiStatusCycle(builderStatus, [
    "Generating...", "Formatting sections...", "Detecting skills...",
  ]);

  const data = getBuilderFieldValues();
  const payload = {
    full_name: fullName, email: data.email, phone: data.phone, target_role: data.targetRole,
    summary: data.summary, skills: data.skills, experience: data.experience, education: data.education,
  };

  try {
    const res = await fetch(`${API_BASE}/generate-resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const resData = await res.json();
    if (!res.ok) throw new Error(resData.error || "Generation failed");

    lastPlainText = resData.resume_text;
    updateLivePreview(); // ensures the panel reflects exactly what was generated

    useForScanBtn.disabled = false;
    saveToHistoryBtn.disabled = false;
    downloadPdfBtn.disabled = false;
    downloadBtn.disabled = false;

    stopStatusCycle();
    showSuccessStatus(builderStatus, `Resume generated — ${resData.detected_skills.length} skills detected.`);
    document.querySelector(".builder-preview-panel").scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (err) {
    console.error(err);
    stopStatusCycle();
    builderStatus.textContent = "Something went wrong — is the backend running on :5000?";
    builderStatus.classList.add("error");
  } finally {
    generateBtn.disabled = false;
    generateBtn.classList.remove("is-loading");
  }
}

addExperienceBtn.addEventListener("click", () => { addExperienceRow(); updateLivePreview(); });
addEducationBtn.addEventListener("click", () => { addEducationRow(); updateLivePreview(); });
generateBtn.addEventListener("click", generateResume);

// Live preview wiring — text fields update on input (debounced), dynamic
// experience/education rows are handled via delegation since they're
// created after page load.
["bFullName", "bEmail", "bPhone", "bTargetRole", "bSummary", "bSkills"].forEach(id => {
  document.getElementById(id).addEventListener("input", scheduleLivePreviewUpdate);
});
experienceList.addEventListener("input", scheduleLivePreviewUpdate);
educationList.addEventListener("input", scheduleLivePreviewUpdate);

useForScanBtn.addEventListener("click", () => {
  resumeText.value = lastPlainText;
  resumeText.scrollIntoView({ behavior: "smooth" });
  resumeText.focus();
});

saveToHistoryBtn.addEventListener("click", async () => {
  if (!currentUser) {
    openAuthModal("login");
    return;
  }
  saveToHistoryBtn.disabled = true;
  saveToHistoryStatus.classList.remove("error");
  saveToHistoryStatus.textContent = "Saving...";
  try {
    const fullName = document.getElementById("bFullName").value.trim() || "resume";
    const filename = `${fullName.toLowerCase().replace(/\s+/g, "-")}.txt`;
    const res = await fetch(`${API_BASE}/resumes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ filename, text: lastPlainText }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error || "Could not save");

    showSuccessStatus(saveToHistoryStatus, "Saved to My Resumes.");
    refreshResumeHistory();
    refreshDashboard();
  } catch (err) {
    saveToHistoryStatus.textContent = err.message;
    saveToHistoryStatus.classList.add("error");
  } finally {
    saveToHistoryBtn.disabled = false;
  }
});

downloadBtn.addEventListener("click", () => {
  const blob = new Blob([lastPlainText], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "resume.txt";
  a.click();
  URL.revokeObjectURL(url);
});

downloadPdfBtn.addEventListener("click", () => {
  window.print();
});

// start with one empty row each so the form isn't empty on load
addExperienceRow();
addEducationRow();
updateLivePreview();

// ---------------------------------------------------------------------------
// AI Career Assistant
// ---------------------------------------------------------------------------
const chatMessages = document.getElementById("chatMessages");
const chatInput = document.getElementById("chatInput");
const chatSendBtn = document.getElementById("chatSendBtn");
const chatStatus = document.getElementById("chatStatus");

let chatHistory = []; // [{ role: "user" | "assistant", content: "..." }]

function renderChat() {
  chatMessages.innerHTML = chatHistory.length
    ? chatHistory.map(m => `<div class="chat-bubble ${m.role}">${escapeHtml(m.content)}</div>`).join("")
    : `<p class="chat-empty">No messages yet — ask something about your resume or matches.</p>`;
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

async function sendChatMessage() {
  const text = chatInput.value.trim();
  if (!text) return;

  if (!currentUser) {
    openAuthModal("login");
    return;
  }

  chatHistory.push({ role: "user", content: text });
  renderChat();
  chatInput.value = "";
  chatStatus.classList.remove("error");
  chatStatus.innerHTML = `Thinking<span class="thinking-dots"><span></span><span></span><span></span></span>`;
  chatSendBtn.disabled = true;

  try {
    const res = await fetch(`${API_BASE}/assistant`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        messages: chatHistory,
        context: {
          resume_text: resumeText.value.trim() || lastPlainText,
          top_matches: lastMatchResults.slice(0, 5),
        },
      }),
    });
    const data = await res.json();

    if (res.status === 401) {
      chatHistory.pop(); // don't leave an unanswered message sitting in history
      renderChat();
      openAuthModal("login");
      return;
    }
    if (!res.ok && isProRequiredResponse(data)) {
      showProLockStatus(chatStatus, data.message);
      return;
    }
    if (!res.ok) throw new Error(data.error || "Assistant failed");

    chatHistory.push({ role: "assistant", content: data.reply });
    renderChat();
    chatStatus.textContent = (data.remaining_today !== null && data.remaining_today !== undefined)
      ? `${data.remaining_today} of ${data.daily_limit} daily messages left on the Free plan.`
      : "";
  } catch (err) {
    console.error(err);
    chatStatus.textContent = err.message || "Something went wrong.";
    chatStatus.classList.add("error");
  } finally {
    chatSendBtn.disabled = false;
  }
}

chatSendBtn.addEventListener("click", sendChatMessage);
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChatMessage();
});

renderChat();
