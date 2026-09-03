"""
AI Resume / Job Matcher — Backend API (FastAPI)
Run: python backend/app.py  (make sure database/seed.py has been run first)
Or:  uvicorn backend.app:app --reload --port 5000   (from the project root)
"""
import os
import re
import json
import sqlite3
import difflib

import requests
from dotenv import load_dotenv
from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import pypdf
import docx as docx_lib

load_dotenv()  # reads a local .env file, if present, into os.environ

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(BASE_DIR, "database", "app.db")
FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")

app = FastAPI(title="SIGNAL — AI Resume Matcher")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# AI Assistant config — needs your own OpenRouter API key (free tier
# available). Get one at https://openrouter.ai/keys, then put it in a
# `.env` file (copy `.env.example` to `.env` and fill in the value).
# Never commit `.env`.
# ---------------------------------------------------------------------------
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY")
OPENROUTER_MODEL = os.environ.get("OPENROUTER_MODEL", "google/gemma-4-31b-it:free")
OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions"


def secure_filename(filename: str) -> str:
    """Minimal filename sanitizer (keeps letters, digits, dot, dash, underscore)."""
    filename = os.path.basename(filename)
    return re.sub(r"[^A-Za-z0-9_.-]", "_", filename)


# ---------------------------------------------------------------------------
# "AI" skill-extraction engine.
# This is a lightweight, explainable NLP approach (no external API key
# needed), which makes the project easy to run and demo end-to-end.
# Swap this for a spaCy or LLM-based pipeline later if you want to extend
# this project further.
#
# Three detection layers, merged together:
#   1. Explicit  — anything literally listed under a "SKILLS" section is
#                  always trusted, even if it's not a "known" skill.
#   2. Vocab     — known skills + common synonyms/job-title variants
#                  (e.g. "programmer" -> software development).
#   3. Fuzzy     — catches small typos against single-word known skills
#                  (e.g. "managemant" -> management).
# ---------------------------------------------------------------------------
SKILL_CATEGORIES = {
    "Tech / IT": [
        "python", "javascript", "typescript", "java", "c++", "sql", "nosql",
        "flask", "django", "fastapi", "react", "vue", "angular", "node.js",
        "express", "html", "css", "git", "docker", "kubernetes", "aws",
        "azure", "gcp", "rest api", "graphql", "pandas", "numpy",
        "machine learning", "deep learning", "tensorflow", "pytorch",
        "data visualization", "responsive design", "linux", "agile", "ci/cd",
        "software development",
    ],
    "Business / Admin": [
        "excel", "microsoft office", "powerpoint", "word", "google sheets",
        "data entry", "bookkeeping", "accounting", "invoicing", "payroll",
        "budgeting", "financial analysis", "forecasting", "sap", "quickbooks",
        "administration", "scheduling", "record keeping", "procurement",
    ],
    "Sales / Marketing": [
        "sales", "digital marketing", "social media marketing", "seo", "sem",
        "content creation", "copywriting", "branding", "market research",
        "crm", "salesforce", "hubspot", "email marketing", "google analytics",
        "advertising", "negotiation", "customer acquisition", "lead generation",
        "marketing",
    ],
    "Customer Service / Hospitality": [
        "customer service", "customer support", "call center", "front desk",
        "hospitality", "food and beverage", "housekeeping", "event planning",
        "reservation management", "complaint handling", "cashiering", "cooking",
    ],
    "Healthcare": [
        "patient care", "nursing", "first aid", "cpr", "clinical assessment",
        "medical records", "phlebotomy", "pharmacology", "healthcare administration",
    ],
    "Education": [
        "teaching", "curriculum development", "lesson planning", "tutoring",
        "classroom management", "training and development", "public speaking",
    ],
    "HR": [
        "recruitment", "human resources", "onboarding", "employee relations",
        "performance management", "talent acquisition", "conflict resolution",
    ],
    "Design / Creative": [
        "graphic design", "photoshop", "illustrator", "figma", "canva",
        "video editing", "photography", "ui/ux design", "adobe premiere",
    ],
    "Logistics / Trades": [
        "supply chain", "inventory management", "warehouse operations",
        "logistics", "quality control", "project management", "operations management",
        "manufacturing", "forklift operation", "safety compliance", "driving",
        "cleaning", "security", "construction",
    ],
    "General": [
        "communication", "leadership", "teamwork", "problem solving",
        "time management", "critical thinking", "adaptability", "multitasking",
        "management",
    ],
}

SKILL_VOCAB = sorted({skill for skills in SKILL_CATEGORIES.values() for skill in skills})
SKILL_TO_CATEGORY = {skill: cat for cat, skills in SKILL_CATEGORIES.items() for skill in skills}

# Common alternate phrasings / job titles that should count as the canonical skill.
SKILL_SYNONYMS = {
    "software development": ["programmer", "programming", "coding", "software developer", "developer", "coder", "software engineer"],
    "accounting": ["accountant", "accounts", "bookkeeper"],
    "administration": ["admin", "administrative", "office admin", "office management"],
    "sales": ["salesperson", "sales rep", "sales representative", "selling"],
    "marketing": ["marketer", "marketing specialist"],
    "food and beverage": ["f&b", "waiter", "waitress", "server", "barista", "food service", "kitchen staff"],
    "cooking": ["cook", "chef", "culinary", "kitchen", "food preparation"],
    "nursing": ["nurse"],
    "teaching": ["teacher", "tutor", "educator", "instructor", "lecturer"],
    "human resources": ["hr", "hr executive", "people operations"],
    "graphic design": ["designer", "graphic designer"],
    "warehouse operations": ["warehouse", "warehouseman"],
    "driving": ["driver", "delivery driver", "courier", "rider"],
    "cleaning": ["cleaner", "housekeeper"],
    "security": ["security guard", "security officer", "guard"],
    "construction": ["construction worker", "builder", "renovation"],
    "manufacturing": ["factory worker", "production operator", "machine operator"],
    "customer service": ["customer service representative", "csr"],
    "management": ["manager", "managing", "supervisory", "supervisor"],
}

# (regex, canonical_skill) pairs — built once at import time.
_SKILL_PATTERNS = [
    (re.compile(r"\b" + re.escape(variant) + r"\b"), canonical)
    for canonical in SKILL_VOCAB
    for variant in [canonical] + SKILL_SYNONYMS.get(canonical, [])
]

# Single-word canonical skills are candidates for typo-tolerant fuzzy matching.
_SINGLE_WORD_SKILLS = [s for s in SKILL_VOCAB if " " not in s and "/" not in s]


def _extract_vocab_skills(text_lower: str) -> set[str]:
    return {canonical for pattern, canonical in _SKILL_PATTERNS if pattern.search(text_lower)}


def _extract_fuzzy_skills(text_lower: str) -> set[str]:
    words = set(re.findall(r"[a-z][a-z\+]{3,}", text_lower))
    found = set()
    for word in words:
        close = difflib.get_close_matches(word, _SINGLE_WORD_SKILLS, n=1, cutoff=0.86)
        if close:
            found.add(close[0])
    return found


def _extract_explicit_skills(text: str) -> set[str]:
    """Anything literally listed under a 'SKILLS' heading is trusted as-is,
    even if it's not in SKILL_VOCAB — this is what the person typed themselves."""
    lines = text.split("\n")
    found = set()
    for i, line in enumerate(lines):
        if line.strip().upper() == "SKILLS":
            for j in range(i + 1, min(i + 4, len(lines))):
                candidate = lines[j].strip()
                if not candidate or set(candidate) <= {"-"}:
                    continue
                found.update(s.strip().lower() for s in candidate.split(",") if s.strip())
                break
    return found


def extract_skills(text: str) -> list[str]:
    text_lower = text.lower()
    combined = (
        _extract_vocab_skills(text_lower)
        | _extract_fuzzy_skills(text_lower)
        | _extract_explicit_skills(text)
    )
    return sorted(combined)


def compute_match(resume_skills: list[str], job_skills: list[str]) -> dict:
    """Exact skill matches count fully. A skill the resume doesn't have
    but that shares a category with something the resume DOES have counts
    as a "related" partial match — this is what makes cross-industry
    resumes score fairly instead of hitting a hard 0%."""
    resume_set = set(resume_skills)
    job_set = set(job_skills)

    exact_matched = sorted(resume_set & job_set)
    resume_categories = {SKILL_TO_CATEGORY[s] for s in resume_set if s in SKILL_TO_CATEGORY}

    related, fully_missing = [], []
    for job_skill in sorted(job_set - resume_set):
        job_category = SKILL_TO_CATEGORY.get(job_skill)
        if job_category and job_category in resume_categories:
            related.append(job_skill)
        else:
            fully_missing.append(job_skill)

    EXACT_WEIGHT, RELATED_WEIGHT = 1.0, 0.3
    total = len(job_set)
    if total:
        weighted = len(exact_matched) * EXACT_WEIGHT + len(related) * RELATED_WEIGHT
        score = round(min(weighted / total, 1.0) * 100, 1)
    else:
        score = 0.0

    return {
        "score": score,
        "matched_skills": exact_matched,
        "related_skills": related,
        "missing_skills": fully_missing,
    }


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


# ---------------------------------------------------------------------------
# Resume builder — turns structured form data into a clean, formatted
# plain-text resume. Template-based (no external API key needed); swap this
# for an LLM call later if you want the wording itself to be AI-generated.
# ---------------------------------------------------------------------------
def build_resume_text(data: dict) -> str:
    full_name = data.get("full_name", "").strip()
    email = data.get("email", "").strip()
    phone = data.get("phone", "").strip()
    target_role = data.get("target_role", "").strip()
    summary = data.get("summary", "").strip()
    skills = [s.strip() for s in data.get("skills", []) if s.strip()]
    experience = data.get("experience", [])
    education = data.get("education", [])

    lines = []
    lines.append(full_name.upper() if full_name else "YOUR NAME")

    contact_line = " | ".join(filter(None, [email, phone]))
    if contact_line:
        lines.append(contact_line)
    if target_role:
        lines.append(f"Target Role: {target_role}")
    lines.append("")

    if summary:
        lines.append("SUMMARY")
        lines.append("-" * 40)
        lines.append(summary)
        lines.append("")

    if skills:
        lines.append("SKILLS")
        lines.append("-" * 40)
        lines.append(", ".join(skills))
        lines.append("")

    if experience:
        lines.append("EXPERIENCE")
        lines.append("-" * 40)
        for exp in experience:
            title = exp.get("title", "").strip()
            duration = exp.get("duration", "").strip()
            description = exp.get("description", "").strip()

            header = title
            if duration:
                header += f" ({duration})"
            if header:
                lines.append(header)
            for row in description.split("\n"):
                if row.strip():
                    lines.append(f"  • {row.strip()}")
            lines.append("")

    if education:
        lines.append("EDUCATION")
        lines.append("-" * 40)
        for edu in education:
            degree = edu.get("degree", "").strip()
            school = edu.get("school", "").strip()
            year = edu.get("year", "").strip()
            row = " — ".join(filter(None, [degree, school]))
            if year:
                row += f" ({year})"
            if row:
                lines.append(row)
        lines.append("")

    return "\n".join(lines).strip() + "\n"


# ---------------------------------------------------------------------------
# File upload — extract plain text from an uploaded .txt / .pdf / .docx file
# so the person can upload their existing resume instead of pasting text.
# ---------------------------------------------------------------------------
ALLOWED_RESUME_EXTENSIONS = {"txt", "pdf", "docx"}


def extract_text_from_upload(file_storage, filename: str) -> str:
    ext = filename.rsplit(".", 1)[-1].lower()

    if ext == "txt":
        return file_storage.read().decode("utf-8", errors="ignore")

    if ext == "pdf":
        reader = pypdf.PdfReader(file_storage)
        return "\n".join(page.extract_text() or "" for page in reader.pages)

    if ext == "docx":
        document = docx_lib.Document(file_storage)
        return "\n".join(p.text for p in document.paragraphs)

    raise ValueError(f"Unsupported file type: .{ext}")


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------
class ExperienceEntry(BaseModel):
    title: str = ""
    company: str = ""
    duration: str = ""
    location: str = ""
    description: str = ""


class EducationEntry(BaseModel):
    degree: str = ""
    school: str = ""
    year: str = ""


class GenerateResumeRequest(BaseModel):
    full_name: str = ""
    email: str = ""
    phone: str = ""
    target_role: str = ""
    summary: str = ""
    skills: list[str] = []
    experience: list[ExperienceEntry] = []
    education: list[EducationEntry] = []


class ResumeTextRequest(BaseModel):
    filename: str = "resume.txt"
    text: str = ""


class ChatMessage(BaseModel):
    role: str
    content: str


class AssistantRequest(BaseModel):
    messages: list[ChatMessage] = []
    context: dict = {}


# ---------------------------------------------------------------------------
# API routes
# ---------------------------------------------------------------------------
@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/jobs")
def list_jobs():
    conn = get_db()
    rows = conn.execute("SELECT * FROM jobs ORDER BY id DESC").fetchall()
    conn.close()
    jobs = []
    for row in rows:
        job = dict(row)
        job["required_skills"] = json.loads(job["required_skills"])
        jobs.append(job)
    return jobs


@app.post("/api/generate-resume")
def generate_resume(payload: GenerateResumeRequest):
    """Accepts structured form data and returns a formatted resume text."""
    if not payload.full_name.strip():
        return JSONResponse(status_code=400, content={"error": "Full name is required"})

    data = payload.model_dump()
    resume_text = build_resume_text(data)
    detected_skills = extract_skills(resume_text)

    return {"resume_text": resume_text, "detected_skills": detected_skills}


@app.post("/api/resumes")
def upload_resume(payload: ResumeTextRequest):
    """Accepts JSON: { "filename": str, "text": str }"""
    filename = payload.filename
    text = payload.text

    if not text.strip():
        return JSONResponse(status_code=400, content={"error": "Resume text is empty"})

    skills = extract_skills(text)

    conn = get_db()
    cur = conn.execute(
        "INSERT INTO resumes (user_id, filename, raw_text, extracted_skills) VALUES (?, ?, ?, ?)",
        (1, filename, text, json.dumps(skills)),
    )
    conn.commit()
    resume_id = cur.lastrowid
    conn.close()

    return {"id": resume_id, "filename": filename, "skills": skills}


@app.post("/api/resumes/upload-file")
def upload_resume_file(file: UploadFile = File(...)):
    """Accepts multipart/form-data with a 'file' field (.txt, .pdf, or .docx)."""
    if not file.filename:
        return JSONResponse(status_code=400, content={"error": "No file selected"})

    filename = secure_filename(file.filename)
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext not in ALLOWED_RESUME_EXTENSIONS:
        return JSONResponse(status_code=400, content={"error": "Unsupported file type. Please upload a .txt, .pdf, or .docx file."})

    try:
        text = extract_text_from_upload(file.file, filename)
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": f"Could not read that file: {str(e)}"})

    if not text.strip():
        return JSONResponse(status_code=400, content={"error": "No readable text found in that file — it might be a scanned image PDF."})

    skills = extract_skills(text)

    conn = get_db()
    cur = conn.execute(
        "INSERT INTO resumes (user_id, filename, raw_text, extracted_skills) VALUES (?, ?, ?, ?)",
        (1, filename, text, json.dumps(skills)),
    )
    conn.commit()
    resume_id = cur.lastrowid
    conn.close()

    return {"id": resume_id, "filename": filename, "text": text, "skills": skills}


@app.get("/api/match/{resume_id}")
def match_resume_to_all_jobs(resume_id: int):
    conn = get_db()
    resume = conn.execute("SELECT * FROM resumes WHERE id = ?", (resume_id,)).fetchone()
    if resume is None:
        conn.close()
        return JSONResponse(status_code=404, content={"error": "Resume not found"})

    resume_skills = json.loads(resume["extracted_skills"])
    jobs = conn.execute("SELECT * FROM jobs ORDER BY id DESC").fetchall()

    results = []
    for job in jobs:
        job_skills = json.loads(job["required_skills"])
        match = compute_match(resume_skills, job_skills)
        conn.execute(
            "INSERT INTO matches (resume_id, job_id, score, matched_skills, missing_skills) VALUES (?, ?, ?, ?, ?)",
            (resume_id, job["id"], match["score"], json.dumps(match["matched_skills"]), json.dumps(match["missing_skills"])),
        )
        results.append({
            "job_id": job["id"],
            "title": job["title"],
            "location": job["location"],
            **match,
        })

    conn.commit()
    conn.close()

    results.sort(key=lambda r: r["score"], reverse=True)
    return {"resume_skills": resume_skills, "results": results}


@app.post("/api/assistant")
def assistant_chat(payload: AssistantRequest):
    """
    AI-powered career assistant. Talks to OpenRouter (OpenAI-compatible API),
    so it needs your own OpenRouter API key — get one free at
    https://openrouter.ai/keys, then put it in a .env file as
    OPENROUTER_API_KEY=... (see .env.example).
    """
    if not OPENROUTER_API_KEY:
        return JSONResponse(status_code=503, content={
            "error": "AI assistant isn't configured yet. Add your OpenRouter API key to a .env file "
                     "as OPENROUTER_API_KEY=... (see .env.example), then restart the server."
        })

    if not payload.messages:
        return JSONResponse(status_code=400, content={"error": "No messages provided"})

    context = payload.context or {}

    system_prompt = (
        "You are the AI Career Assistant embedded inside SIGNAL, a resume-and-job-matching app. "
        "Give concise, specific, practical advice — a few short paragraphs or a short bullet list at most. "
        "When the user's resume text or job-match results are given below, ground your answers in that "
        "real data instead of generic advice. If asked something totally unrelated to careers/resumes, "
        "answer briefly and steer back to how you can help with their job search."
    )

    if context.get("resume_text"):
        system_prompt += f"\n\n--- USER'S CURRENT RESUME ---\n{context['resume_text']}"
    if context.get("top_matches"):
        system_prompt += f"\n\n--- THEIR TOP JOB MATCHES (from the scanner) ---\n{json.dumps(context['top_matches'], indent=2)}"

    # OpenRouter uses the OpenAI chat-completions format: system prompt goes
    # inside the messages array, not as a separate top-level field.
    chat_messages = [{"role": "system", "content": system_prompt}] + [
        m.model_dump() for m in payload.messages
    ]

    try:
        resp = requests.post(
            OPENROUTER_API_URL,
            headers={
                "Authorization": f"Bearer {OPENROUTER_API_KEY}",
                "Content-Type": "application/json",
                "HTTP-Referer": "http://localhost:5000",
                "X-Title": "SIGNAL Resume Matcher",
            },
            json={
                "model": OPENROUTER_MODEL,
                "messages": chat_messages,
            },
            timeout=30,
        )
    except requests.exceptions.RequestException as e:
        return JSONResponse(status_code=502, content={"error": f"Couldn't reach the AI service: {str(e)}"})

    if resp.status_code != 200:
        try:
            detail = resp.json().get("error", {}).get("message", resp.text)
        except Exception:
            detail = resp.text
        return JSONResponse(status_code=502, content={"error": f"AI service error ({resp.status_code}): {detail}"})

    result = resp.json()
    try:
        reply_text = result["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        reply_text = ""
    return {"reply": reply_text}


# ---------------------------------------------------------------------------
# Serve the frontend (must be mounted LAST so it doesn't shadow /api routes)
# ---------------------------------------------------------------------------
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn

    if not os.path.exists(DB_PATH):
        print("Database not found — run `python database/seed.py` first.")
    uvicorn.run(app, host="0.0.0.0", port=5000)