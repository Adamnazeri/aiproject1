"""
AI Resume / Job Matcher — Backend API (FastAPI)
Run: python backend/app.py  (make sure database/seed.py has been run first)
Or:  uvicorn backend.app:app --reload --port 5000   (from the project root)
"""
import os
import re
import json
import time
import sqlite3
import difflib
import hashlib
import hmac
import base64
import secrets

import requests
from dotenv import load_dotenv
from fastapi import FastAPI, UploadFile, File, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import pypdf
import docx as docx_lib

load_dotenv()  # reads a local .env file, if present, into os.environ

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(BASE_DIR, "database", "app.db")
FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")

app = FastAPI(title="ResumeMaker — AI Resume Matcher")
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

# ---------------------------------------------------------------------------
# Auth config — used to sign login tokens. Set a real random value in your
# .env as SECRET_KEY=... in production (see .env.example).
# ---------------------------------------------------------------------------
SECRET_KEY = os.environ.get("SECRET_KEY", "dev-only-change-this-secret-key")
TOKEN_LIFETIME_SECONDS = 60 * 60 * 24 * 7  # 7 days


def secure_filename(filename: str) -> str:
    """Minimal filename sanitizer (keeps letters, digits, dot, dash, underscore)."""
    filename = os.path.basename(filename)
    return re.sub(r"[^A-Za-z0-9_.-]", "_", filename)


# ---------------------------------------------------------------------------
# Password hashing (PBKDF2-SHA256, stdlib only — no extra dependency needed)
# ---------------------------------------------------------------------------
def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), 100_000)
    return f"{salt}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        salt, digest_hex = stored.split("$", 1)
    except ValueError:
        return False
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), 100_000)
    return hmac.compare_digest(digest.hex(), digest_hex)


# ---------------------------------------------------------------------------
# Simple signed auth tokens (HMAC — stdlib only, no JWT dependency needed).
# Format: base64("<user_id>:<expiry_ts>:<signature>")
# ---------------------------------------------------------------------------
def create_token(user_id: int) -> str:
    expiry = int(time.time()) + TOKEN_LIFETIME_SECONDS
    payload = f"{user_id}:{expiry}"
    signature = hmac.new(SECRET_KEY.encode(), payload.encode(), hashlib.sha256).hexdigest()
    raw = f"{payload}:{signature}"
    return base64.urlsafe_b64encode(raw.encode()).decode()


def verify_token(token: str):
    try:
        raw = base64.urlsafe_b64decode(token.encode()).decode()
        user_id_str, expiry_str, signature = raw.split(":")
        payload = f"{user_id_str}:{expiry_str}"
        expected_sig = hmac.new(SECRET_KEY.encode(), payload.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected_sig):
            return None
        if int(expiry_str) < int(time.time()):
            return None
        return int(user_id_str)
    except Exception:
        return None


def get_current_user_id(authorization: str = Header(None)):
    """Returns the user_id if a valid Bearer token is present, else None.
    Endpoints decide for themselves whether auth is required."""
    if not authorization or not authorization.startswith("Bearer "):
        return None
    token = authorization.removeprefix("Bearer ").strip()
    return verify_token(token)


def require_user_id(authorization: str = Header(None)):
    user_id = get_current_user_id(authorization)
    if user_id is None:
        return None
    return user_id


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
    """Multi-factor match score, built only from signals that actually exist
    in the data (resume skills vs. job's required skills) — no fabricated
    experience/education/seniority claims, since the current pipeline
    doesn't extract those as structured fields yet.

    Skill Match  — exact skill overlap, weighted.
    Domain Match — category overlap (e.g. resume is "Tech/IT" heavy and the
                   job's unmatched skills still fall in a category the
                   resume already touches) — this is what makes cross-field
                   resumes score fairly instead of a hard 0%, and is exposed
                   as its own line in the breakdown rather than hidden.
    """
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

    total = len(job_set)
    if total:
        skill_match_pct = round(len(exact_matched) / total * 100, 1)
        domain_match_pct = round(min(len(exact_matched) + len(related), total) / total * 100, 1)
        EXACT_WEIGHT, RELATED_WEIGHT = 1.0, 0.3
        weighted = len(exact_matched) * EXACT_WEIGHT + len(related) * RELATED_WEIGHT
        overall_score = round(min(weighted / total, 1.0) * 100, 1)
    else:
        skill_match_pct = domain_match_pct = overall_score = 0.0

    if overall_score >= 80:
        recommendation = "Strong match — you should apply."
    elif overall_score >= 55:
        recommendation = "Good match — worth applying, but consider closing a few skill gaps first."
    elif overall_score >= 30:
        recommendation = "Partial match — you meet some requirements, but this role may be a stretch."
    else:
        recommendation = "Low match — your current skill set doesn't line up well with this role yet."

    return {
        "score": overall_score,
        "breakdown": {
            "skill_match": skill_match_pct,
            "domain_match": domain_match_pct,
        },
        "matched_skills": exact_matched,
        "related_skills": related,
        "missing_skills": fully_missing,
        "recommendation": recommendation,
    }


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


# ---------------------------------------------------------------------------
# Centralized Free/Pro entitlements — checked server-side, never trusted from
# the frontend. Add a feature name here once and gate any endpoint with
# `require_feature(user_id, "feature_name")` instead of scattering plan
# checks around the codebase.
# ---------------------------------------------------------------------------
PLAN_FEATURES = {
    "free": {
        "basic_matching",
    },
    "pro": {
        "basic_matching",
        "advanced_matching",       # full score breakdown + full skill-gap list
        "ai_assistant_unlimited",
        "resume_history",
        "application_tracker",
        "priority_refresh",
        "unlimited_saved_jobs",
    },
}


def get_user_plan(user_id):
    if user_id is None:
        return "free"
    conn = get_db()
    row = conn.execute("SELECT plan FROM users WHERE id = ?", (user_id,)).fetchone()
    conn.close()
    return (row["plan"] if row else "free") or "free"


def has_feature(user_id, feature: str) -> bool:
    plan = get_user_plan(user_id)
    return feature in PLAN_FEATURES.get(plan, PLAN_FEATURES["free"])


# Numeric caps for Free plan — used alongside the boolean PLAN_FEATURES flags
# above for things that are "limited" rather than fully on/off.
FREE_LIMITS = {
    "saved_jobs": 5,
    "ai_assistant_daily": 10,
    "resume_history": 3,
    "match_refresh_cooldown_seconds": 300,  # 5 minutes
}


def pro_required_response(feature: str, message: str, status_code: int = 403) -> JSONResponse:
    """Standard shape for every plan-gated denial, so the frontend can handle
    all of them with one generic handler instead of parsing different error
    strings per endpoint."""
    return JSONResponse(status_code=status_code, content={
        "error": "pro_required", "feature": feature, "message": message,
    })


def require_feature(user_id, feature: str, message: str):
    """Returns a JSONResponse to send back immediately if the user's plan
    doesn't include `feature`, or None if they're allowed to proceed.
    Usage: `denial = require_feature(user_id, "application_tracker", "...")`
           `if denial: return denial`"""
    if not has_feature(user_id, feature):
        return pro_required_response(feature, message)
    return None


DEMO_JOBS = [
    {
        "title": "Operations Manager", "company": "Meridian Logistics", "logo_emoji": "📦",
        "description": "Oversee daily warehouse and fleet operations, manage a team of 15, and drive process improvements across the supply chain.",
        "required_skills": ["operations management", "team leadership", "logistics", "inventory management", "communication"],
        "preferred_skills": ["excel", "sap"],
        "location": "Petaling Jaya, Selangor", "salary_min": 5500, "salary_max": 7500, "currency": "MYR",
        "employment_type": "Full-time", "experience_required": "3-5 years", "education_required": "Diploma or Degree",
        "industry": "Logistics / Supply Chain", "application_url": "", "source": "ResumeMaker Demo Listing",
    },
    {
        "title": "Project Manager", "company": "Northbridge Consulting", "logo_emoji": "📋",
        "description": "Lead cross-functional project teams from planning through delivery for enterprise clients.",
        "required_skills": ["project management", "communication", "leadership", "budgeting", "microsoft office"],
        "preferred_skills": ["agile", "power bi"],
        "location": "Kuala Lumpur", "salary_min": 6000, "salary_max": 9000, "currency": "MYR",
        "employment_type": "Full-time", "experience_required": "4-6 years", "education_required": "Degree",
        "industry": "Professional Services", "application_url": "", "source": "ResumeMaker Demo Listing",
    },
    {
        "title": "Software Engineer (Backend)", "company": "Pulsewave Technologies", "logo_emoji": "💻",
        "description": "Build and maintain REST APIs and services powering our core product, working closely with product and data teams.",
        "required_skills": ["python", "fastapi", "sql", "git", "rest api"],
        "preferred_skills": ["docker", "aws"],
        "location": "Remote (Malaysia)", "salary_min": 6500, "salary_max": 11000, "currency": "MYR",
        "employment_type": "Full-time", "experience_required": "2-4 years", "education_required": "Degree",
        "industry": "Technology", "application_url": "", "source": "ResumeMaker Demo Listing",
    },
    {
        "title": "Customer Service Executive", "company": "Harbor Retail Group", "logo_emoji": "🎧",
        "description": "Handle customer inquiries across phone, chat and email, and resolve complaints in line with SLA targets.",
        "required_skills": ["customer service", "communication", "problem solving", "crm"],
        "preferred_skills": ["salesforce"],
        "location": "Johor Bahru, Johor", "salary_min": 2500, "salary_max": 3500, "currency": "MYR",
        "employment_type": "Full-time", "experience_required": "0-2 years", "education_required": "SPM or Diploma",
        "industry": "Retail", "application_url": "", "source": "ResumeMaker Demo Listing",
    },
    {
        "title": "Digital Marketing Executive", "company": "Brightleaf Media", "logo_emoji": "📣",
        "description": "Plan and run paid and organic campaigns across social platforms, and report on performance to clients.",
        "required_skills": ["digital marketing", "seo", "social media marketing", "content creation", "google analytics"],
        "preferred_skills": ["email marketing", "copywriting"],
        "location": "Penang", "salary_min": 3000, "salary_max": 4800, "currency": "MYR",
        "employment_type": "Full-time", "experience_required": "1-3 years", "education_required": "Diploma or Degree",
        "industry": "Marketing / Advertising", "application_url": "", "source": "ResumeMaker Demo Listing",
    },
    {
        "title": "Business Executive", "company": "Meridian Logistics", "logo_emoji": "📈",
        "description": "Support business development, prepare proposals, and coordinate with operations to onboard new accounts.",
        "required_skills": ["sales", "negotiation", "communication", "market research", "excel"],
        "preferred_skills": ["crm", "financial analysis"],
        "location": "Petaling Jaya, Selangor", "salary_min": 3500, "salary_max": 5000, "currency": "MYR",
        "employment_type": "Full-time", "experience_required": "1-3 years", "education_required": "Degree",
        "industry": "Logistics / Supply Chain", "application_url": "", "source": "ResumeMaker Demo Listing",
    },
]


def ensure_schema_upgrades():
    """Adds new columns/tables to an already-existing database without
    wiping data. Safe to run every startup — each change is skipped if it
    already exists."""
    if not os.path.exists(DB_PATH):
        return
    conn = sqlite3.connect(DB_PATH)

    users_cols = {row[1] for row in conn.execute("PRAGMA table_info(users)").fetchall()}
    user_upgrades = {
        "plan": "ALTER TABLE users ADD COLUMN plan TEXT DEFAULT 'free'",
        "plan_started_at": "ALTER TABLE users ADD COLUMN plan_started_at TIMESTAMP",
    }
    for col, stmt in user_upgrades.items():
        if col not in users_cols:
            conn.execute(stmt)

    jobs_cols = {row[1] for row in conn.execute("PRAGMA table_info(jobs)").fetchall()}
    job_upgrades = {
        "logo_emoji": "ALTER TABLE jobs ADD COLUMN logo_emoji TEXT DEFAULT '🏢'",
        "preferred_skills": "ALTER TABLE jobs ADD COLUMN preferred_skills TEXT DEFAULT '[]'",
        "salary_min": "ALTER TABLE jobs ADD COLUMN salary_min INTEGER",
        "salary_max": "ALTER TABLE jobs ADD COLUMN salary_max INTEGER",
        "currency": "ALTER TABLE jobs ADD COLUMN currency TEXT DEFAULT 'MYR'",
        "employment_type": "ALTER TABLE jobs ADD COLUMN employment_type TEXT",
        "experience_required": "ALTER TABLE jobs ADD COLUMN experience_required TEXT",
        "education_required": "ALTER TABLE jobs ADD COLUMN education_required TEXT",
        "industry": "ALTER TABLE jobs ADD COLUMN industry TEXT",
        "application_url": "ALTER TABLE jobs ADD COLUMN application_url TEXT",
        "source": "ALTER TABLE jobs ADD COLUMN source TEXT",
        "posted_date": "ALTER TABLE jobs ADD COLUMN posted_date TIMESTAMP",
        "closing_date": "ALTER TABLE jobs ADD COLUMN closing_date TIMESTAMP",
    }
    for col, stmt in job_upgrades.items():
        if col not in jobs_cols:
            conn.execute(stmt)
            if col == "posted_date":
                # SQLite won't allow DEFAULT CURRENT_TIMESTAMP directly in
                # ALTER TABLE ADD COLUMN ("non-constant default"), so the
                # column above is added plain, then backfilled here instead.
                conn.execute("UPDATE jobs SET posted_date = CURRENT_TIMESTAMP WHERE posted_date IS NULL")

    conn.execute("""
        CREATE TABLE IF NOT EXISTS saved_jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            job_id INTEGER NOT NULL,
            saved_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, job_id)
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS applications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            job_id INTEGER NOT NULL,
            resume_id INTEGER,
            status TEXT NOT NULL DEFAULT 'saved',  -- saved, applied, screening, interview, offer, rejected
            applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS ai_usage (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            usage_date TEXT NOT NULL,   -- 'YYYY-MM-DD', server date
            count INTEGER NOT NULL DEFAULT 0,
            UNIQUE(user_id, usage_date)
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS match_refresh_log (
            user_id INTEGER PRIMARY KEY,
            last_refreshed_at TIMESTAMP NOT NULL
        )
    """)

    # Backfill a small set of realistic demo jobs if the jobs table is empty,
    # so matching/dashboard/tracker all have something real to work with.
    job_count = conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0]
    if job_count == 0:
        for job in DEMO_JOBS:
            conn.execute(
                """INSERT INTO jobs
                   (title, company, description, required_skills, location, logo_emoji,
                    preferred_skills, salary_min, salary_max, currency, employment_type,
                    experience_required, education_required, industry, application_url, source,
                    posted_date)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)""",
                (
                    job["title"], job["company"], job["description"], json.dumps(job["required_skills"]),
                    job["location"], job["logo_emoji"], json.dumps(job["preferred_skills"]),
                    job["salary_min"], job["salary_max"], job["currency"], job["employment_type"],
                    job["experience_required"], job["education_required"], job["industry"],
                    job["application_url"], job["source"],
                ),
            )

    conn.commit()
    conn.close()


ensure_schema_upgrades()


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


class SignupRequest(BaseModel):
    name: str
    email: str
    password: str


class LoginRequest(BaseModel):
    email: str
    password: str


class SubscribeRequest(BaseModel):
    plan: str  # "free" | "pro"


class SaveJobRequest(BaseModel):
    job_id: int


class ApplicationRequest(BaseModel):
    job_id: int
    resume_id: int | None = None
    status: str = "applied"


class ApplicationStatusUpdate(BaseModel):
    status: str  # saved, applied, screening, interview, offer, rejected


VALID_APPLICATION_STATUSES = {"saved", "applied", "screening", "interview", "offer", "rejected"}


# ---------------------------------------------------------------------------
# Auth routes
# ---------------------------------------------------------------------------
@app.post("/api/auth/signup")
def signup(payload: SignupRequest):
    name = payload.name.strip()
    email = payload.email.strip().lower()
    password = payload.password

    if not name or not email or not password:
        return JSONResponse(status_code=400, content={"error": "Name, email and password are all required"})
    if len(password) < 6:
        return JSONResponse(status_code=400, content={"error": "Password must be at least 6 characters"})

    conn = get_db()
    existing = conn.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
    if existing:
        conn.close()
        return JSONResponse(status_code=409, content={"error": "An account with that email already exists"})

    password_hash = hash_password(password)
    cur = conn.execute(
        "INSERT INTO users (name, email, password_hash, plan) VALUES (?, ?, ?, 'free')",
        (name, email, password_hash),
    )
    conn.commit()
    user_id = cur.lastrowid
    conn.close()

    token = create_token(user_id)
    return {"token": token, "user": {"id": user_id, "name": name, "email": email, "plan": "free"}}


@app.post("/api/auth/login")
def login(payload: LoginRequest):
    email = payload.email.strip().lower()
    conn = get_db()
    user = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    conn.close()

    if user is None or not verify_password(payload.password, user["password_hash"]):
        return JSONResponse(status_code=401, content={"error": "Incorrect email or password"})

    token = create_token(user["id"])
    return {
        "token": token,
        "user": {"id": user["id"], "name": user["name"], "email": user["email"], "plan": user["plan"] or "free"},
    }


@app.get("/api/auth/me")
def me(authorization: str = Header(None)):
    user_id = get_current_user_id(authorization)
    if user_id is None:
        return JSONResponse(status_code=401, content={"error": "Not authenticated"})
    conn = get_db()
    user = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    conn.close()
    if user is None:
        return JSONResponse(status_code=401, content={"error": "Not authenticated"})
    return {"id": user["id"], "name": user["name"], "email": user["email"], "plan": user["plan"] or "free"}


# ---------------------------------------------------------------------------
# Mock subscription routes — no real payment gateway wired up yet. Swap the
# body of `subscribe()` for a real Stripe Checkout session later; the
# frontend contract (POST plan -> user's plan updates) can stay the same.
# ---------------------------------------------------------------------------
@app.post("/api/subscribe")
def subscribe(payload: SubscribeRequest, authorization: str = Header(None)):
    user_id = get_current_user_id(authorization)
    if user_id is None:
        return JSONResponse(status_code=401, content={"error": "Please log in first"})
    if payload.plan not in ("free", "pro"):
        return JSONResponse(status_code=400, content={"error": "Unknown plan"})

    conn = get_db()
    conn.execute(
        "UPDATE users SET plan = ?, plan_started_at = CURRENT_TIMESTAMP WHERE id = ?",
        (payload.plan, user_id),
    )
    conn.commit()
    conn.close()
    return {"plan": payload.plan, "status": "mock_success", "message": "This is a demo checkout — no real payment was taken."}


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
        job["preferred_skills"] = json.loads(job.get("preferred_skills") or "[]")
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


@app.get("/api/resumes")
def list_my_resumes(authorization: str = Header(None)):
    """Resume history. Free plan only sees the most recent
    FREE_LIMITS["resume_history"] resumes; Pro sees everything. This doesn't
    limit scanning itself (that stays unlimited on Free) — only how much of
    the saved history is browsable."""
    user_id = get_current_user_id(authorization)
    if user_id is None:
        return JSONResponse(status_code=401, content={"error": "Please log in first"})

    conn = get_db()
    total_count = conn.execute("SELECT COUNT(*) FROM resumes WHERE user_id = ?", (user_id,)).fetchone()[0]

    is_unlimited = has_feature(user_id, "resume_history")
    limit = None if is_unlimited else FREE_LIMITS["resume_history"]

    query = "SELECT id, filename, extracted_skills, uploaded_at FROM resumes WHERE user_id = ? ORDER BY uploaded_at DESC"
    params = (user_id,)
    if limit is not None:
        query += " LIMIT ?"
        params = (user_id, limit)
    rows = conn.execute(query, params).fetchall()
    conn.close()

    resumes = [{
        "id": r["id"], "filename": r["filename"], "uploaded_at": r["uploaded_at"],
        "skill_count": len(json.loads(r["extracted_skills"] or "[]")),
    } for r in rows]

    return {
        "resumes": resumes,
        "total_count": total_count,
        "plan_limited": limit is not None and total_count > limit,
        "locked_count": max(total_count - limit, 0) if limit is not None else 0,
    }


def get_resume_visible_ids(user_id: int, conn) -> set:
    """IDs of this user's resumes that fall within their plan's history
    window (most-recent-first, capped for Free). Download/delete both check
    against this — the same window list_my_resumes() shows — so a Free user
    can't reach an older, "locked" resume just by guessing/reusing its id in
    a direct API call."""
    is_unlimited = has_feature(user_id, "resume_history")
    query = "SELECT id FROM resumes WHERE user_id = ? ORDER BY uploaded_at DESC"
    params = (user_id,)
    if not is_unlimited:
        query += " LIMIT ?"
        params = (user_id, FREE_LIMITS["resume_history"])
    return {r["id"] for r in conn.execute(query, params).fetchall()}


@app.get("/api/resumes/{resume_id}/download")
def download_resume(resume_id: int, authorization: str = Header(None)):
    user_id = get_current_user_id(authorization)
    if user_id is None:
        return JSONResponse(status_code=401, content={"error": "Please log in first"})

    conn = get_db()
    resume = conn.execute(
        "SELECT * FROM resumes WHERE id = ? AND user_id = ?", (resume_id, user_id)
    ).fetchone()
    if resume is None:
        conn.close()
        return JSONResponse(status_code=404, content={"error": "Resume not found"})

    if resume_id not in get_resume_visible_ids(user_id, conn):
        conn.close()
        return pro_required_response(
            "resume_history",
            "This resume is outside your Free plan's 3 most-recent saved resumes. Upgrade to Pro to access your full history.",
        )
    conn.close()

    filename = resume["filename"] or f"resume-{resume_id}.txt"
    if not filename.lower().endswith(".txt"):
        filename += ".txt"

    return Response(
        content=resume["raw_text"],
        media_type="text/plain",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.delete("/api/resumes/{resume_id}")
def delete_resume(resume_id: int, authorization: str = Header(None)):
    user_id = get_current_user_id(authorization)
    if user_id is None:
        return JSONResponse(status_code=401, content={"error": "Please log in first"})

    conn = get_db()
    resume = conn.execute(
        "SELECT id FROM resumes WHERE id = ? AND user_id = ?", (resume_id, user_id)
    ).fetchone()
    if resume is None:
        conn.close()
        return JSONResponse(status_code=404, content={"error": "Resume not found"})

    conn.execute("DELETE FROM resumes WHERE id = ?", (resume_id,))
    conn.commit()
    conn.close()
    return {"status": "deleted", "id": resume_id}


@app.post("/api/resumes")
def upload_resume(payload: ResumeTextRequest, authorization: str = Header(None)):
    """Accepts JSON: { "filename": str, "text": str }"""
    filename = payload.filename
    text = payload.text

    if not text.strip():
        return JSONResponse(status_code=400, content={"error": "Resume text is empty"})

    skills = extract_skills(text)
    user_id = get_current_user_id(authorization) or 1

    conn = get_db()
    cur = conn.execute(
        "INSERT INTO resumes (user_id, filename, raw_text, extracted_skills) VALUES (?, ?, ?, ?)",
        (user_id, filename, text, json.dumps(skills)),
    )
    conn.commit()
    resume_id = cur.lastrowid
    conn.close()

    return {"id": resume_id, "filename": filename, "skills": skills}


@app.post("/api/resumes/upload-file")
def upload_resume_file(file: UploadFile = File(...), authorization: str = Header(None)):
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
    user_id = get_current_user_id(authorization) or 1

    conn = get_db()
    cur = conn.execute(
        "INSERT INTO resumes (user_id, filename, raw_text, extracted_skills) VALUES (?, ?, ?, ?)",
        (user_id, filename, text, json.dumps(skills)),
    )
    conn.commit()
    resume_id = cur.lastrowid
    conn.close()

    return {"id": resume_id, "filename": filename, "text": text, "skills": skills}


@app.get("/api/match/{resume_id}")
def match_resume_to_all_jobs(resume_id: int, authorization: str = Header(None)):
    user_id = get_current_user_id(authorization)
    is_pro = has_feature(user_id, "advanced_matching")

    conn = get_db()
    resume = conn.execute("SELECT * FROM resumes WHERE id = ?", (resume_id,)).fetchone()
    if resume is None:
        conn.close()
        return JSONResponse(status_code=404, content={"error": "Resume not found"})

    # Priority match refresh: Free (logged-in) users can only recompute
    # matches once every FREE_LIMITS["match_refresh_cooldown_seconds"]; Pro
    # bypasses this entirely. Guests (no account) aren't rate-limited here —
    # there's no plan to enforce against an anonymous session.
    if user_id is not None and not has_feature(user_id, "priority_refresh"):
        row = conn.execute("SELECT last_refreshed_at FROM match_refresh_log WHERE user_id = ?", (user_id,)).fetchone()
        if row is not None:
            elapsed = time.time() - row["last_refreshed_at"]
            cooldown = FREE_LIMITS["match_refresh_cooldown_seconds"]
            if elapsed < cooldown:
                conn.close()
                wait = int(cooldown - elapsed)
                return JSONResponse(status_code=429, content={
                    "error": "pro_required", "feature": "priority_refresh",
                    "message": f"Free plan can refresh matches every {cooldown // 60} minutes — Pro gets unlimited priority refresh.",
                    "retry_after_seconds": wait,
                })

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

        result = {
            "job_id": job["id"],
            "title": job["title"],
            "company": job["company"],
            "logo_emoji": job["logo_emoji"] or "🏢",
            "location": job["location"],
            "salary_min": job["salary_min"],
            "salary_max": job["salary_max"],
            "currency": job["currency"] or "MYR",
            "employment_type": job["employment_type"],
            "industry": job["industry"],
            "application_url": job["application_url"],
            **match,
        }

        if not is_pro:
            # Free plan: overall score + recommendation + a capped preview of
            # matched/missing skills. Full breakdown + full lists are Pro.
            result["matched_skills"] = result["matched_skills"][:5]
            result["related_skills"] = result["related_skills"][:2]
            result["missing_skills"] = result["missing_skills"][:3]
            result["breakdown"] = None
            result["pro_locked"] = True
        else:
            result["pro_locked"] = False

        results.append(result)

    if user_id is not None:
        conn.execute(
            "INSERT INTO match_refresh_log (user_id, last_refreshed_at) VALUES (?, ?) "
            "ON CONFLICT(user_id) DO UPDATE SET last_refreshed_at = excluded.last_refreshed_at",
            (user_id, time.time()),
        )

    conn.commit()
    conn.close()

    results.sort(key=lambda r: r["score"], reverse=True)
    return {"resume_skills": resume_skills, "results": results, "plan": "pro" if is_pro else "free"}


# ---------------------------------------------------------------------------
# Saved jobs
# ---------------------------------------------------------------------------
@app.get("/api/saved-jobs")
def list_saved_jobs(authorization: str = Header(None)):
    user_id = get_current_user_id(authorization)
    if user_id is None:
        return JSONResponse(status_code=401, content={"error": "Please log in first"})
    conn = get_db()
    rows = conn.execute("""
        SELECT saved_jobs.job_id, saved_jobs.saved_at, jobs.title, jobs.company, jobs.logo_emoji, jobs.location
        FROM saved_jobs JOIN jobs ON jobs.id = saved_jobs.job_id
        WHERE saved_jobs.user_id = ? ORDER BY saved_jobs.saved_at DESC
    """, (user_id,)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.post("/api/saved-jobs")
def save_job(payload: SaveJobRequest, authorization: str = Header(None)):
    user_id = get_current_user_id(authorization)
    if user_id is None:
        return JSONResponse(status_code=401, content={"error": "Please log in first"})
    conn = get_db()
    job = conn.execute("SELECT id FROM jobs WHERE id = ?", (payload.job_id,)).fetchone()
    if job is None:
        conn.close()
        return JSONResponse(status_code=404, content={"error": "Job not found"})

    if not has_feature(user_id, "unlimited_saved_jobs"):
        current_count = conn.execute("SELECT COUNT(*) FROM saved_jobs WHERE user_id = ?", (user_id,)).fetchone()[0]
        already_saved = conn.execute(
            "SELECT 1 FROM saved_jobs WHERE user_id = ? AND job_id = ?", (user_id, payload.job_id)
        ).fetchone()
        limit = FREE_LIMITS["saved_jobs"]
        if not already_saved and current_count >= limit:
            conn.close()
            return pro_required_response(
                "unlimited_saved_jobs",
                f"Free plan is limited to {limit} saved jobs — upgrade to Pro for unlimited saved jobs.",
            )

    conn.execute(
        "INSERT OR IGNORE INTO saved_jobs (user_id, job_id) VALUES (?, ?)",
        (user_id, payload.job_id),
    )
    conn.commit()
    conn.close()
    return {"status": "saved", "job_id": payload.job_id}


@app.delete("/api/saved-jobs/{job_id}")
def unsave_job(job_id: int, authorization: str = Header(None)):
    user_id = get_current_user_id(authorization)
    if user_id is None:
        return JSONResponse(status_code=401, content={"error": "Please log in first"})
    conn = get_db()
    conn.execute("DELETE FROM saved_jobs WHERE user_id = ? AND job_id = ?", (user_id, job_id))
    conn.commit()
    conn.close()
    return {"status": "removed", "job_id": job_id}


# ---------------------------------------------------------------------------
# Application tracker — users can only ever see/modify their own rows
# (every query below is scoped by user_id from the verified auth token).
# ---------------------------------------------------------------------------
@app.get("/api/applications")
def list_applications(authorization: str = Header(None)):
    user_id = get_current_user_id(authorization)
    if user_id is None:
        return JSONResponse(status_code=401, content={"error": "Please log in first"})
    denial = require_feature(user_id, "application_tracker",
                              "The application tracker is available on the Pro plan.")
    if denial:
        return denial
    conn = get_db()
    rows = conn.execute("""
        SELECT applications.id, applications.job_id, applications.resume_id, applications.status,
               applications.applied_at, applications.updated_at,
               jobs.title, jobs.company, jobs.logo_emoji
        FROM applications JOIN jobs ON jobs.id = applications.job_id
        WHERE applications.user_id = ? ORDER BY applications.updated_at DESC
    """, (user_id,)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.post("/api/applications")
def create_application(payload: ApplicationRequest, authorization: str = Header(None)):
    user_id = get_current_user_id(authorization)
    if user_id is None:
        return JSONResponse(status_code=401, content={"error": "Please log in first"})
    denial = require_feature(user_id, "application_tracker",
                              "The application tracker is available on the Pro plan.")
    if denial:
        return denial
    if payload.status not in VALID_APPLICATION_STATUSES:
        return JSONResponse(status_code=400, content={"error": "Invalid status"})

    conn = get_db()
    job = conn.execute("SELECT id FROM jobs WHERE id = ?", (payload.job_id,)).fetchone()
    if job is None:
        conn.close()
        return JSONResponse(status_code=404, content={"error": "Job not found"})

    # ownership check: if a resume_id is supplied, it must belong to this user
    if payload.resume_id is not None:
        resume = conn.execute("SELECT id FROM resumes WHERE id = ? AND user_id = ?", (payload.resume_id, user_id)).fetchone()
        if resume is None:
            conn.close()
            return JSONResponse(status_code=403, content={"error": "That resume doesn't belong to you"})

    cur = conn.execute(
        "INSERT INTO applications (user_id, job_id, resume_id, status) VALUES (?, ?, ?, ?)",
        (user_id, payload.job_id, payload.resume_id, payload.status),
    )
    conn.commit()
    application_id = cur.lastrowid
    conn.close()
    return {"id": application_id, "status": payload.status}


@app.patch("/api/applications/{application_id}")
def update_application_status(application_id: int, payload: ApplicationStatusUpdate, authorization: str = Header(None)):
    user_id = get_current_user_id(authorization)
    if user_id is None:
        return JSONResponse(status_code=401, content={"error": "Please log in first"})
    denial = require_feature(user_id, "application_tracker",
                              "The application tracker is available on the Pro plan.")
    if denial:
        return denial
    if payload.status not in VALID_APPLICATION_STATUSES:
        return JSONResponse(status_code=400, content={"error": "Invalid status"})

    conn = get_db()
    # ownership check — a user can only update their own application rows
    owned = conn.execute(
        "SELECT id FROM applications WHERE id = ? AND user_id = ?", (application_id, user_id)
    ).fetchone()
    if owned is None:
        conn.close()
        return JSONResponse(status_code=404, content={"error": "Application not found"})

    conn.execute(
        "UPDATE applications SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        (payload.status, application_id),
    )
    conn.commit()
    conn.close()
    return {"id": application_id, "status": payload.status}


# ---------------------------------------------------------------------------
# Dashboard summary — small, fast aggregate query built entirely from the
# user's own rows (auth required; every subquery is scoped to user_id).
# ---------------------------------------------------------------------------
@app.get("/api/dashboard")
def dashboard_summary(authorization: str = Header(None)):
    user_id = get_current_user_id(authorization)
    if user_id is None:
        return JSONResponse(status_code=401, content={"error": "Please log in first"})

    conn = get_db()
    latest_resume = conn.execute(
        "SELECT id, extracted_skills FROM resumes WHERE user_id = ? ORDER BY uploaded_at DESC LIMIT 1", (user_id,)
    ).fetchone()

    resume_score = 0
    jobs_matched = 0
    if latest_resume:
        resume_skills = json.loads(latest_resume["extracted_skills"])
        jobs = conn.execute("SELECT required_skills FROM jobs").fetchall()
        scores = []
        for job in jobs:
            job_skills = json.loads(job["required_skills"])
            match = compute_match(resume_skills, job_skills)
            scores.append(match["score"])
            if match["score"] >= 40:
                jobs_matched += 1
        # Resume score out of 100: how well the resume performs against the
        # best-fitting roles in the database (average of its top matches).
        top_scores = sorted(scores, reverse=True)[:5]
        resume_score = round(sum(top_scores) / len(top_scores)) if top_scores else 0

    saved_count = conn.execute("SELECT COUNT(*) FROM saved_jobs WHERE user_id = ?", (user_id,)).fetchone()[0]
    applications_count = conn.execute("SELECT COUNT(*) FROM applications WHERE user_id = ?", (user_id,)).fetchone()[0]
    interviews_count = conn.execute(
        "SELECT COUNT(*) FROM applications WHERE user_id = ? AND status IN ('interview', 'offer')", (user_id,)
    ).fetchone()[0]
    conn.close()

    return {
        "resume_score": resume_score,
        "jobs_matched": jobs_matched,
        "saved_jobs": saved_count,
        "applications": applications_count,
        "interviews": interviews_count,
        "has_resume": latest_resume is not None,
    }

@app.post("/api/assistant")
def assistant_chat(payload: AssistantRequest, authorization: str = Header(None)):
    """
    AI-powered career assistant. Talks to OpenRouter (OpenAI-compatible API),
    so it needs your own OpenRouter API key — get one free at
    https://openrouter.ai/keys, then put it in a .env file as
    OPENROUTER_API_KEY=... (see .env.example).

    Free plan: capped at FREE_LIMITS["ai_assistant_daily"] messages/day.
    Pro plan: unlimited. Requires login either way, since usage is tracked
    per account.
    """
    user_id = get_current_user_id(authorization)
    if user_id is None:
        return JSONResponse(status_code=401, content={"error": "Please log in to use the AI Assistant."})

    if not OPENROUTER_API_KEY:
        return JSONResponse(status_code=503, content={
            "error": "AI assistant isn't configured yet. Add your OpenRouter API key to a .env file "
                     "as OPENROUTER_API_KEY=... (see .env.example), then restart the server."
        })

    if not payload.messages:
        return JSONResponse(status_code=400, content={"error": "No messages provided"})

    is_unlimited = has_feature(user_id, "ai_assistant_unlimited")
    today = time.strftime("%Y-%m-%d")
    conn = get_db()
    usage_row = conn.execute(
        "SELECT count FROM ai_usage WHERE user_id = ? AND usage_date = ?", (user_id, today)
    ).fetchone()
    used_today = usage_row["count"] if usage_row else 0
    daily_limit = FREE_LIMITS["ai_assistant_daily"]

    if not is_unlimited and used_today >= daily_limit:
        conn.close()
        return pro_required_response(
            "ai_assistant_unlimited",
            f"You've used today's {daily_limit} Free AI Assistant messages — upgrade to Pro for unlimited access.",
            status_code=403,
        )
    conn.close()

    context = payload.context or {}

    system_prompt = (
        "You are the AI Career Assistant embedded inside ResumeMaker, a resume-and-job-matching app. "
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
                "X-Title": "ResumeMaker",
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

    # Only count successful replies against the daily quota — a failed
    # upstream call above returns before this point and doesn't cost the user.
    if not is_unlimited:
        conn = get_db()
        conn.execute(
            "INSERT INTO ai_usage (user_id, usage_date, count) VALUES (?, ?, 1) "
            "ON CONFLICT(user_id, usage_date) DO UPDATE SET count = count + 1",
            (user_id, today),
        )
        conn.commit()
        conn.close()
        remaining = max(daily_limit - (used_today + 1), 0)
    else:
        remaining = None

    return {"reply": reply_text, "remaining_today": remaining, "daily_limit": None if is_unlimited else daily_limit}


# ---------------------------------------------------------------------------
# Serve the frontend (must be mounted LAST so it doesn't shadow /api routes)
# ---------------------------------------------------------------------------
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn

    if not os.path.exists(DB_PATH):
        print("Database not found — run `python database/seed.py` first.")
    uvicorn.run(app, host="0.0.0.0", port=5000)
