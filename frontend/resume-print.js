const PRINT_API_BASE = `${window.location.origin}/api`;
const printStatus = document.getElementById("printStatus");
const printButton = document.getElementById("printButton");
const resumeSheet = document.getElementById("resumeSheet");

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value == null ? "" : String(value);
  return div.innerHTML;
}

function asText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function getInitials(name) {
  return asText(name).split(/\s+/).filter(Boolean).slice(0, 2)
    .map(part => part[0].toUpperCase()).join("") || "?";
}

function safePhotoDataUrl(value) {
  return /^data:image\/(png|jpe?g|webp|gif);base64,/i.test(value || "") ? value : "";
}

function normaliseVisualData(data) {
  const template = ["minimal", "sidebar", "bold"].includes(data?.template) ? data.template : "minimal";
  const entries = (items, fields) => Array.isArray(items) ? items.map(item => Object.fromEntries(
    fields.map(field => [field, asText(item?.[field])])
  )) : [];
  return {
    template,
    fullName: asText(data?.fullName),
    email: asText(data?.email),
    phone: asText(data?.phone),
    targetRole: asText(data?.targetRole),
    summary: asText(data?.summary),
    skills: Array.isArray(data?.skills) ? data.skills.map(asText).filter(Boolean) : [],
    experience: entries(data?.experience, ["title", "company", "duration", "location", "description"]),
    education: entries(data?.education, ["degree", "school", "year"]),
    photoDataUrl: safePhotoDataUrl(data?.photoDataUrl),
  };
}

function plainTextFallback(rawText) {
  const lines = String(rawText || "").replace(/\r\n/g, "\n").split("\n");
  const firstContent = lines.findIndex(line => line.trim());
  const result = {
    template: "sidebar", fullName: "Resume", email: "", phone: "", targetRole: "",
    summary: "", skills: [], experience: [], education: [], photoDataUrl: "",
  };
  if (firstContent < 0) return result;

  result.fullName = lines[firstContent].trim();
  let index = firstContent + 1;
  if (lines[index] && !/^[A-Z ]+$/.test(lines[index].trim())) {
    const contact = lines[index].split(/\s*[|·]\s*/).map(part => part.trim()).filter(Boolean);
    result.email = contact.find(part => part.includes("@")) || "";
    result.phone = contact.find(part => part !== result.email) || "";
    index += 1;
  }
  if (/^target role:/i.test(lines[index] || "")) {
    result.targetRole = lines[index].replace(/^target role:\s*/i, "").trim();
  }

  const sections = {};
  let current = "";
  for (const line of lines.slice(index)) {
    const header = line.trim().toUpperCase();
    if (["SUMMARY", "SKILLS", "EXPERIENCE", "EDUCATION"].includes(header)) {
      current = header;
      sections[current] = [];
    } else if (current && !/^-{3,}$/.test(line.trim())) {
      sections[current].push(line);
    }
  }
  result.summary = (sections.SUMMARY || []).join("\n").trim();
  result.skills = (sections.SKILLS || []).join(",").split(/[,\n]/)
    .map(item => item.replace(/^[•*-]\s*/, "").trim()).filter(Boolean);

  const groups = items => {
    const output = []; let group = [];
    for (const line of items || []) {
      if (!line.trim()) { if (group.length) output.push(group), group = []; }
      else group.push(line.trim());
    }
    if (group.length) output.push(group);
    return output;
  };
  result.experience = groups(sections.EXPERIENCE).map(group => {
    const [first = "", ...remaining] = group;
    const [title, company] = first.split(/\s*[—–-]\s*/, 2);
    const meta = remaining.find(line => !/^[•*-]\s*/.test(line)) || "";
    return {
      title: title || "", company: company || "", duration: meta, location: "",
      description: remaining.filter(line => /^[•*-]\s*/.test(line)).map(line => line.replace(/^[•*-]\s*/, "")).join("\n"),
    };
  });
  result.education = groups(sections.EDUCATION).map(group => ({
    degree: group[0] || "", school: group.slice(1).join(" "), year: "",
  }));
  return result;
}

function renderResumeVisual(data) {
  const validExperience = data.experience.filter(item => item.title || item.company || item.description);
  const validEducation = data.education.filter(item => item.degree || item.school || item.year);
  const avatar = data.photoDataUrl
    ? `<img class="r-avatar" src="${escapeHtml(data.photoDataUrl)}" alt="Profile photo">`
    : `<div class="r-avatar" style="display:flex;align-items:center;justify-content:center;font-size:18pt;font-weight:700;color:#64748b;">${escapeHtml(getInitials(data.fullName))}</div>`;
  const contactInline = [data.email, data.phone].filter(Boolean).map(escapeHtml).join(" &middot; ");
  const contactStacked = [data.email, data.phone].filter(Boolean).map(escapeHtml).join("<br>");
  const skills = data.skills.map(skill => `<span class="r-skill-pill">${escapeHtml(skill)}</span>`).join("");
  const experience = validExperience.map(item => {
    const title = [item.title, item.company].filter(Boolean).map(escapeHtml).join(" &mdash; ");
    const meta = [item.duration, item.location].filter(Boolean).map(escapeHtml).join(" &middot; ");
    const bullets = item.description.split("\n").map(line => line.trim()).filter(Boolean)
      .map(line => `<li>${escapeHtml(line)}</li>`).join("");
    return `<section class="r-entry"><div class="r-entry-title">${title}</div>${meta ? `<div class="r-entry-sub">${meta}</div>` : ""}${bullets ? `<ul>${bullets}</ul>` : ""}</section>`;
  }).join("");
  const education = validEducation.map(item => {
    const details = [item.school, item.year].filter(Boolean).map(escapeHtml).join(" &middot; ");
    return `<section class="r-entry"><div class="r-entry-title">${escapeHtml(item.degree)}</div>${details ? `<div class="r-entry-sub">${details}</div>` : ""}</section>`;
  }).join("");

  if (data.template === "sidebar") {
    return `<div class="resume-doc tpl-sidebar"><aside class="r-side">${avatar}<div class="r-name">${escapeHtml(data.fullName)}</div>${data.targetRole ? `<div class="r-role">${escapeHtml(data.targetRole)}</div>` : ""}<div class="r-contact">${contactStacked}</div>${data.skills.length ? `<div class="r-section-title">Skills</div><div>${skills}</div>` : ""}${validEducation.length ? `<div class="r-section-title">Education</div>${education}` : ""}</aside><section class="r-main">${data.summary ? `<div class="r-section-title">Summary</div><p>${escapeHtml(data.summary)}</p>` : ""}${validExperience.length ? `<div class="r-section-title">Experience</div>${experience}` : ""}</section></div>`;
  }
  if (data.template === "bold") {
    return `<div class="resume-doc tpl-bold"><header class="r-header">${avatar}<div><div class="r-name">${escapeHtml(data.fullName)}</div>${data.targetRole ? `<div class="r-role">${escapeHtml(data.targetRole)}</div>` : ""}<div class="r-contact">${contactInline}</div></div></header><main class="r-body"><section>${data.skills.length ? `<div class="r-section-title">Skills</div><div>${skills}</div>` : ""}${validEducation.length ? `<div class="r-section-title">Education</div>${education}` : ""}</section><section>${data.summary ? `<div class="r-section-title">Summary</div><p>${escapeHtml(data.summary)}</p>` : ""}${validExperience.length ? `<div class="r-section-title">Experience</div>${experience}` : ""}</section></main></div>`;
  }
  return `<div class="resume-doc tpl-minimal"><header class="r-header">${avatar}<div class="r-name">${escapeHtml(data.fullName)}</div>${data.targetRole ? `<div class="r-role">${escapeHtml(data.targetRole)}</div>` : ""}<div class="r-contact">${contactInline}</div></header>${data.summary ? `<div class="r-section-title">Summary</div><p>${escapeHtml(data.summary)}</p>` : ""}${data.skills.length ? `<div class="r-section-title">Skills</div><div>${skills}</div>` : ""}${validExperience.length ? `<div class="r-section-title">Experience</div>${experience}` : ""}${validEducation.length ? `<div class="r-section-title">Education</div>${education}` : ""}</div>`;
}

async function startPrintView() {
  const resumeId = Number(new URLSearchParams(window.location.search).get("id"));
  const token = localStorage.getItem("signal_token");
  if (!Number.isInteger(resumeId) || resumeId < 1 || !token) throw new Error("Please log in, then open the resume from your dashboard again.");
  const response = await fetch(`${PRINT_API_BASE}/resumes/${resumeId}/print-data`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || payload.error || "Could not load this resume.");

  const baseName = (payload.filename || "resume").replace(/\.(txt|pdf|docx)$/i, "");
  document.title = `${baseName}.pdf`;
  const visual = payload.visual_data ? normaliseVisualData(payload.visual_data) : plainTextFallback(payload.raw_text);
  resumeSheet.innerHTML = renderResumeVisual(visual);
  printStatus.textContent = payload.visual_data ? "Your Live Preview layout is ready." : "Using a Sidebar layout for this older text-only save.";
  await document.fonts?.ready;
  await Promise.all([...resumeSheet.querySelectorAll("img")].map(image => image.decode?.().catch(() => {})));
  window.setTimeout(() => window.print(), 150);
}

printButton.addEventListener("click", () => window.print());
startPrintView().catch(error => {
  printStatus.textContent = "Could not prepare this resume.";
  resumeSheet.innerHTML = `<div class="error-card">${escapeHtml(error.message)}</div>`;
  printButton.hidden = true;
});
