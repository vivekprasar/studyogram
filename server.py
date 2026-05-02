import sqlite3
import json
import time
import bcrypt
import jwt
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Depends
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import List

SECRET_KEY = "super_secret_studyogram_key"

# --- DATABASE SETUP ---
def init_db():
    conn = sqlite3.connect('studyogram.db')
    c = conn.cursor()
    c.execute('''CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    email TEXT UNIQUE,
                    password_hash TEXT,
                    name TEXT,
                    branch TEXT,
                    semester TEXT,
                    bio TEXT,
                    points INTEGER DEFAULT 0,
                    streak INTEGER DEFAULT 0
                 )''')
    c.execute('''CREATE TABLE IF NOT EXISTS posts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    author_id INTEGER,
                    author_name TEXT,
                    type TEXT,
                    title TEXT,
                    content TEXT,
                    likes INTEGER DEFAULT 0,
                    time TEXT
                 )''')
    c.execute('''CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    sender_name TEXT,
                    text TEXT,
                    is_encrypted BOOLEAN,
                    is_ai BOOLEAN,
                    time TEXT
                 )''')
    conn.commit()
    conn.close()

init_db()

def get_db():
    conn = sqlite3.connect('studyogram.db')
    conn.row_factory = sqlite3.Row
    return conn

# --- APP INITIALIZATION ---
app = FastAPI()
app.mount("/js", StaticFiles(directory="js"), name="js")

# --- MODELS ---
class SignupRequest(BaseModel):
    name: str
    email: str
    password: str
    branch: str
    semester: str

class LoginRequest(BaseModel):
    email: str
    password: str

class PostCreate(BaseModel):
    type: str
    title: str
    content: str
    token: str

# --- REST APIs ---
def get_user_from_token(token: str):
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=["HS256"])
        return payload
    except:
        return None

@app.post("/api/signup")
def signup(req: SignupRequest):
    conn = get_db()
    c = conn.cursor()
    pwd_hash = bcrypt.hashpw(req.password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
    try:
        c.execute("INSERT INTO users (email, password_hash, name, branch, semester, bio) VALUES (?, ?, ?, ?, ?, ?)",
                  (req.email, pwd_hash, req.name, req.branch, req.semester, "New student!"))
        conn.commit()
        return {"success": True}
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=400, detail="Email already exists")
    finally:
        conn.close()

@app.post("/api/login")
def login(req: LoginRequest):
    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT * FROM users WHERE email=?", (req.email,))
    user = c.fetchone()
    conn.close()
    
    if user and bcrypt.checkpw(req.password.encode('utf-8'), user['password_hash'].encode('utf-8')):
        token_payload = {"id": user["id"], "name": user["name"]}
        token = jwt.encode(token_payload, SECRET_KEY, algorithm="HS256")
        user_dict = dict(user)
        del user_dict["password_hash"]
        return {"success": True, "token": token, "user": user_dict}
    else:
        raise HTTPException(status_code=401, detail="Invalid credentials")

@app.get("/api/posts")
def get_posts():
    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT * FROM posts ORDER BY id DESC")
    posts = [dict(row) for row in c.fetchall()]
    conn.close()
    return {"posts": posts}

@app.post("/api/posts")
def create_post(req: PostCreate):
    user = get_user_from_token(req.token)
    if not user: raise HTTPException(status_code=401)
    
    conn = get_db()
    c = conn.cursor()
    c.execute("INSERT INTO posts (author_id, author_name, type, title, content, time) VALUES (?, ?, ?, ?, ?, ?)",
              (user["id"], user["name"], req.type, req.title, req.content, "Just now"))
    conn.commit()
    conn.close()
    return {"success": True}

# --- WEBSOCKET & AI CHATBOT ---
class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        
        # Send history
        conn = get_db()
        c = conn.cursor()
        c.execute("SELECT * FROM messages ORDER BY id ASC LIMIT 50")
        history = [dict(row) for row in c.fetchall()]
        conn.close()
        for msg in history:
            # ensure boolean types for json serialization
            msg['is_encrypted'] = bool(msg['is_encrypted'])
            msg['is_ai'] = bool(msg['is_ai'])
            await websocket.send_text(json.dumps(msg))

    def disconnect(self, websocket: WebSocket):
        self.active_connections.remove(websocket)

    async def broadcast(self, message: dict):
        for connection in self.active_connections:
            await connection.send_text(json.dumps(message))

manager = ConnectionManager()

def simulate_ai_response(prompt: str) -> str:
    # A simple mock AI logic based on keywords
    prompt_lower = prompt.lower()
    if "binary search" in prompt_lower:
        return "Binary search is an efficient algorithm for finding an item from a sorted list of items. It works by repeatedly dividing in half the portion of the list that could contain the item, until you've narrowed down the possible locations to just one. Time complexity is O(log n)."
    elif "react" in prompt_lower:
        return "React is a JavaScript library for building user interfaces. It lets you compose complex UIs from small and isolated pieces of code called 'components'."
    else:
        return f"I am a simulated AI. I see you asked about '{prompt}'. To answer this accurately, I would normally query a language model! Keep studying hard!"

@app.websocket("/ws/chat")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            msg_data = json.loads(data)
            
            # Save incoming message
            conn = get_db()
            c = conn.cursor()
            c.execute("INSERT INTO messages (sender_name, text, is_encrypted, is_ai, time) VALUES (?, ?, ?, ?, ?)",
                      (msg_data["sender_name"], msg_data["text"], msg_data.get("is_encrypted", False), False, "Now"))
            conn.commit()
            
            await manager.broadcast(msg_data)
            
            # Process AI if triggered
            if not msg_data.get("is_encrypted", False) and "@AI" in msg_data["text"]:
                # Wait slightly to simulate processing
                time.sleep(0.5)
                ai_text = simulate_ai_response(msg_data["text"].replace("@AI", "").strip())
                ai_msg = {
                    "sender_name": "Studyogram AI",
                    "text": ai_text,
                    "is_encrypted": False,
                    "is_ai": True,
                    "time": "Now"
                }
                c.execute("INSERT INTO messages (sender_name, text, is_encrypted, is_ai, time) VALUES (?, ?, ?, ?, ?)",
                          (ai_msg["sender_name"], ai_msg["text"], False, True, "Now"))
                conn.commit()
                await manager.broadcast(ai_msg)
                
            conn.close()
    except WebSocketDisconnect:
        manager.disconnect(websocket)

# --- STATIC ROUTING ---
@app.get("/")
def serve_index():
    return FileResponse("index.html")

@app.get("/{filename}")
def serve_static(filename: str):
    import os
    if os.path.exists(filename):
        return FileResponse(filename)
    raise HTTPException(status_code=404)

if __name__ == "__main__":
    import uvicorn
    import os
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
