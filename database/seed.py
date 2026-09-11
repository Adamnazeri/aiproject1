"""
Seed the database with sample job listings so the app has data to match against.
Run: python database/seed.py
"""
import sqlite3
import json
import os

DB_PATH = os.path.join(os.path.dirname(__file__), "app.db")

SAMPLE_JOBS = [
    # --- Tech ---
    {
        "title": "Backend Engineer",
        "company": "Nexora Systems",
        "description": "Build and maintain REST APIs, work with relational databases, and ship features in a Python/Flask stack.",
        "required_skills": ["python", "flask", "sql", "rest api", "git", "docker"],
    },
    {
        "title": "Full-Stack Developer",
        "company": "Bit Foundry",
        "description": "Work across the stack — Python backend, JavaScript frontend, and a SQL database.",
        "required_skills": ["python", "javascript", "sql", "flask", "html", "css", "git"],
    },
    # --- Marketing / Sales ---
    {
        "title": "Digital Marketing Executive",
        "description": "Plan and run social media and email campaigns, track performance with analytics, and grow organic reach.",
        "required_skills": ["digital marketing", "social media marketing", "seo", "content creation", "google analytics", "email marketing"],
    },
    {
        "title": "Sales Executive",
        "description": "Manage client relationships, generate leads, and close deals using our CRM system.",
        "required_skills": ["sales", "negotiation", "crm", "lead generation", "communication", "customer service"],
    },
    # --- Finance / Admin ---
    {
        "title": "Accounts Executive",
        "description": "Handle bookkeeping, invoicing, and monthly financial reporting for SME clients.",
        "required_skills": ["accounting", "bookkeeping", "invoicing", "excel", "financial analysis", "quickbooks"],
    },
    {
        "title": "Admin Executive",
        "description": "Support day-to-day office operations, scheduling, and record keeping.",
        "required_skills": ["administration", "data entry", "scheduling", "microsoft office", "record keeping", "communication"],
    },
    # --- Healthcare ---
    {
        "title": "Staff Nurse",
        "description": "Provide direct patient care, maintain medical records, and support clinical assessments on the ward.",
        "required_skills": ["nursing", "patient care", "first aid", "cpr", "medical records", "clinical assessment"],
    },
    # --- Education ---
    {
        "title": "English Tutor",
        "description": "Plan lessons and teach English to primary and secondary students in small groups.",
        "required_skills": ["teaching", "lesson planning", "tutoring", "classroom management", "communication"],
    },
    # --- Hospitality / Customer Service ---
    {
        "title": "Front Desk Associate",
        "description": "Welcome guests, manage reservations and check-ins, and resolve guest complaints.",
        "required_skills": ["front desk", "hospitality", "reservation management", "customer service", "complaint handling", "communication"],
    },
    # --- Design ---
    {
        "title": "Graphic Designer",
        "description": "Design social media assets, brand materials, and marketing collateral for local clients.",
        "required_skills": ["graphic design", "photoshop", "illustrator", "figma", "canva", "branding"],
    },
    # --- Logistics / Operations ---
    {
        "title": "Warehouse Supervisor",
        "description": "Oversee inventory accuracy, coordinate warehouse staff, and maintain safety compliance.",
        "required_skills": ["warehouse operations", "inventory management", "logistics", "safety compliance", "leadership", "operations management"],
    },
    # --- HR ---
    {
        "title": "HR Executive",
        "description": "Manage recruitment, onboarding, and employee relations for a growing team.",
        "required_skills": ["human resources", "recruitment", "onboarding", "employee relations", "communication", "conflict resolution"],
    },
    # --- F&B ---
    {
        "title": "Line Cook",
        "description": "Prepare dishes to spec, keep the station clean, and work fast during service rush.",
        "required_skills": ["cooking", "food and beverage", "safety compliance", "teamwork", "time management"],
    },
    # --- Logistics ---
    {
        "title": "Delivery Rider",
        "description": "Handle daily parcel deliveries across the Klang Valley area, on time and safely.",
        "required_skills": ["driving", "safety compliance", "customer service", "time management"],
    },
]


def seed():
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    with open(os.path.join(os.path.dirname(__file__), "schema.sql")) as f:
        cur.executescript(f.read())

    cur.execute("SELECT COUNT(*) FROM jobs")
    if cur.fetchone()[0] > 0:
        print("Jobs table already has data — skipping seed.")
        conn.close()
        return

    for job in SAMPLE_JOBS:
        cur.execute(
            "INSERT INTO jobs (title, company, description, required_skills, location) VALUES (?, ?, ?, ?, ?)",
            (
                job["title"],
                job["company"],
                job["description"],
                json.dumps(job["required_skills"]),
                job["location"],
            ),
        )

    conn.commit()
    conn.close()
    print(f"Seeded {len(SAMPLE_JOBS)} jobs into {DB_PATH}")


if __name__ == "__main__":
    seed()