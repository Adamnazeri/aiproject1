const API_BASE = "http://localhost:5000/api";

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
  localStorage.removeItem("signal_token");
  renderAuthArea();
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
    <div class="user-chip">
      <span>${escapeHtml(currentUser.name)}</span>
      <span class="plan-badge ${plan === "pro" ? "pro" : ""}">${plan}</span>
    </div>
    <button type="button" class="nav-btn ghost" id="logoutBtn">Log out</button>
  `;
  document.getElementById("logoutBtn").addEventListener("click", () => {
    clearSession();
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

function renderMatches(results) {
  matchListEl.innerHTML = results.map(r => `
    <div class="match-card">
      <div class="match-card-top">
        <div>
          <div class="match-title">${r.title}</div>
        </div>
        <div class="match-score">${r.score}%</div>
      </div>
      <div class="meter"><div class="meter-fill" data-width="${r.score}"></div></div>
      <div class="skill-row">
        ${r.matched_skills.map(s => `<span class="skill-pill-matched">${s}</span>`).join("")}
        ${r.related_skills.map(s => `<span class="skill-pill-related">${s} · related</span>`).join("")}
        ${r.missing_skills.map(s => `<span class="skill-pill-missing">${s}</span>`).join("")}
      </div>
    </div>
  `).join("");

  // animate meters in after paint
  requestAnimationFrame(() => {
    document.querySelectorAll(".meter-fill").forEach(el => {
      el.style.width = el.dataset.width + "%";
    });
  });
}

let lastMatchResults = [];

async function fetchAndRenderMatches(resumeId) {
  const matchRes = await fetch(`${API_BASE}/match/${resumeId}`);
  const matchData = await matchRes.json();
  if (!matchRes.ok) throw new Error(matchData.error || "Match failed");

  renderSkillTags(matchData.resume_skills);
  renderMatches(matchData.results);
  lastMatchResults = matchData.results;
  resultsSection.hidden = false;
  resultsSection.scrollIntoView({ behavior: "smooth" });
  return matchData;
}

async function runScan() {
  const text = resumeText.value.trim();
  if (!text) {
    statusMsg.textContent = "Paste some resume text first.";
    statusMsg.classList.add("error");
    return;
  }

  statusMsg.classList.remove("error");
  statusMsg.textContent = "Scanning...";
  scanBtn.disabled = true;

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
    statusMsg.textContent = `Scan complete — ${matchData.results.length} channels checked.`;
  } catch (err) {
    console.error(err);
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
  fileUploadStatus.textContent = `Reading ${file.name}...`;

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
    fileUploadStatus.textContent = `Loaded ${data.filename} — ${matchData.results.length} channels checked.`;
  } catch (err) {
    console.error(err);
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
const downloadPdfBtn = document.getElementById("downloadPdfBtn");
const downloadBtn = document.getElementById("downloadBtn");
const bPhoto = document.getElementById("bPhoto");
const photoPreview = document.getElementById("photoPreview");
const removePhotoBtn = document.getElementById("removePhotoBtn");
const templatePicker = document.getElementById("templatePicker");

let photoDataUrl = null;
let selectedTemplate = "minimal";
let lastPlainText = "";

// --- Photo upload ---
bPhoto.addEventListener("change", () => {
  const file = bPhoto.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    photoDataUrl = reader.result;
    photoPreview.innerHTML = `<img src="${photoDataUrl}" alt="Your photo">`;
  };
  reader.readAsDataURL(file);
});

removePhotoBtn.addEventListener("click", () => {
  photoDataUrl = null;
  bPhoto.value = "";
  photoPreview.innerHTML = "No photo";
});

// --- Template picker ---
templatePicker.querySelectorAll(".template-option").forEach(opt => {
  opt.addEventListener("click", () => {
    templatePicker.querySelectorAll(".template-option").forEach(o => o.classList.remove("selected"));
    opt.classList.add("selected");
    selectedTemplate = opt.dataset.template;
  });
});

// --- Experience / education rows ---
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
  row.querySelector(".remove-entry-btn").addEventListener("click", () => row.remove());
  experienceList.appendChild(row);
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
  row.querySelector(".remove-entry-btn").addEventListener("click", () => row.remove());
  educationList.appendChild(row);
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

// --- Generate: calls backend for plain text + skill detection, renders visual locally ---
async function generateResume() {
  const fullName = document.getElementById("bFullName").value.trim();
  if (!fullName) {
    builderStatus.textContent = "Full name is required.";
    builderStatus.classList.add("error");
    return;
  }

  builderStatus.classList.remove("error");
  builderStatus.textContent = "Generating...";
  generateBtn.disabled = true;

  const email = document.getElementById("bEmail").value.trim();
  const phone = document.getElementById("bPhone").value.trim();
  const targetRole = document.getElementById("bTargetRole").value.trim();
  const summary = document.getElementById("bSummary").value.trim();
  const skills = document.getElementById("bSkills").value.split(",").map(s => s.trim()).filter(Boolean);
  const experience = collectEntries(experienceList);
  const education = collectEntries(educationList);

  const payload = {
    full_name: fullName, email, phone, target_role: targetRole,
    summary, skills, experience, education,
  };

  try {
    const res = await fetch(`${API_BASE}/generate-resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Generation failed");

    lastPlainText = data.resume_text;

    resumeVisual.innerHTML = renderResumeVisual(selectedTemplate, {
      fullName, email, phone, targetRole, summary, skills, experience, education, photoDataUrl,
    });

    generatedPreview.hidden = false;
    generatedPreview.scrollIntoView({ behavior: "smooth" });
    builderStatus.textContent = `Resume generated — ${data.detected_skills.length} skills detected.`;
  } catch (err) {
    console.error(err);
    builderStatus.textContent = "Something went wrong — is the backend running on :5000?";
    builderStatus.classList.add("error");
  } finally {
    generateBtn.disabled = false;
  }
}

addExperienceBtn.addEventListener("click", addExperienceRow);
addEducationBtn.addEventListener("click", addEducationRow);
generateBtn.addEventListener("click", generateResume);

useForScanBtn.addEventListener("click", () => {
  resumeText.value = lastPlainText;
  resumeText.scrollIntoView({ behavior: "smooth" });
  resumeText.focus();
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

  chatHistory.push({ role: "user", content: text });
  renderChat();
  chatInput.value = "";
  chatStatus.classList.remove("error");
  chatStatus.textContent = "Thinking...";
  chatSendBtn.disabled = true;

  try {
    const res = await fetch(`${API_BASE}/assistant`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: chatHistory,
        context: {
          resume_text: resumeText.value.trim() || lastPlainText,
          top_matches: lastMatchResults.slice(0, 5),
        },
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Assistant failed");

    chatHistory.push({ role: "assistant", content: data.reply });
    renderChat();
    chatStatus.textContent = "";
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
