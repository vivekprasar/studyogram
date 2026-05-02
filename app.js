import { AppState } from './js/data.js';
import { renderHome, renderNotes, renderGroups, renderExchange, renderProfile, renderChat } from './js/views.js';

// DOM Elements
const mainContent = document.getElementById('main-content');
const bottomNav = document.getElementById('bottom-nav');
const navItems = document.querySelectorAll('.nav-item');
const toastContainer = document.getElementById('toast-container');

// Global Toast
window.showToast = function(message) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `<i data-lucide="info" style="width: 16px;"></i> <span>${message}</span>`;
    toastContainer.appendChild(toast);
    if (window.lucide) window.lucide.createIcons();
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(-10px)';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
};

// --- E2EE CRYPTOGRAPHY UTILS ---
const E2E_PASSWORD = "studyogram_secure_room"; 
let aesKey = null;

async function deriveKey() {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(E2E_PASSWORD), "PBKDF2", false, ["deriveKey"]);
    aesKey = await crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: enc.encode("study_salt"), iterations: 100000, hash: "SHA-256" },
        keyMaterial, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
    );
}
deriveKey();

async function encryptMessage(text) {
    const enc = new TextEncoder();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, aesKey, enc.encode(text));
    const ivBase64 = btoa(String.fromCharCode(...iv));
    const encryptedBase64 = btoa(String.fromCharCode(...new Uint8Array(encrypted)));
    return ivBase64 + ":" + encryptedBase64;
}

async function decryptMessage(cipherText) {
    try {
        const parts = cipherText.split(":");
        const iv = new Uint8Array(atob(parts[0]).split("").map(c => c.charCodeAt(0)));
        const data = new Uint8Array(atob(parts[1]).split("").map(c => c.charCodeAt(0)));
        const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, aesKey, data);
        return new TextDecoder().decode(decrypted);
    } catch (e) {
        return "🔒 [Encrypted Message]";
    }
}

// --- WEBSOCKET CHAT LOGIC ---
let ws = null;
export function connectWebSocket() {
    if (ws) ws.close();
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${wsProtocol}//${window.location.host}/ws/chat`);
    ws.onmessage = async (event) => {
        const msg = JSON.parse(event.data);
        const chatBox = document.getElementById('chat-messages');
        if (chatBox) {
            let displayText = msg.text;
            if (msg.is_encrypted) {
                displayText = await decryptMessage(msg.text);
            }
            
            const isMe = msg.sender_name === AppState.user.name;
            const bubbleClass = msg.is_ai ? 'ai' : (isMe ? 'me' : 'other');
            const iconHtml = msg.is_ai ? '<i data-lucide="bot" style="width:14px; margin-right:4px;"></i>' : '';
            const lockHtml = msg.is_encrypted ? '<i data-lucide="lock" style="width:10px; margin-left:4px; opacity:0.5;"></i>' : '';
            
            chatBox.innerHTML += `
                <div style="display: flex; flex-direction: column; align-items: ${isMe ? 'flex-end' : 'flex-start'}; margin-bottom: 12px;">
                    <span class="caption" style="margin-bottom: 4px; display:flex; align-items:center;">
                        ${iconHtml} ${msg.sender_name} ${lockHtml}
                    </span>
                    <div class="chat-bubble ${bubbleClass}">
                        ${displayText}
                    </div>
                </div>
            `;
            chatBox.scrollTop = chatBox.scrollHeight;
            if (window.lucide) window.lucide.createIcons();
        }
    };
}

window.sendMessage = async function() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (text !== '' && ws) {
        if (text.startsWith('@AI')) {
            // Unencrypted for AI processing
            ws.send(JSON.stringify({ sender_name: AppState.user.name, text: text, is_encrypted: false }));
        } else {
            // End-to-End Encrypted
            const cipherText = await encryptMessage(text);
            ws.send(JSON.stringify({ sender_name: AppState.user.name, text: cipherText, is_encrypted: true }));
        }
        input.value = '';
    }
};

// --- ROUTING ---
window.navigateTo = function(screenId) {
    navItems.forEach(item => {
        if (item.dataset.target === screenId) item.classList.add('active');
        else item.classList.remove('active');
    });

    let contentHtml = '';
    switch(screenId) {
        case 'home': contentHtml = renderHome(); break;
        case 'notes': contentHtml = renderNotes(); break;
        case 'groups': contentHtml = renderGroups(); break;
        case 'exchange': contentHtml = renderExchange(); break;
        case 'profile': contentHtml = renderProfile(); break;
        case 'chat': contentHtml = renderChat(); break;
        default: contentHtml = renderHome();
    }
    
    mainContent.innerHTML = contentHtml;
    mainContent.className = 'screen active';
    if (window.lucide) window.lucide.createIcons();
    
    if (screenId === 'chat') {
        bottomNav.classList.add('hidden');
        connectWebSocket();
    } else {
        if (AppState.user) bottomNav.classList.remove('hidden');
        if (ws) { ws.close(); ws = null; }
    }
}

// --- AUTHENTICATION ---
window.login = async function() {
    const email = document.getElementById('login-email').value;
    const pass = document.getElementById('login-pass').value;
    try {
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({email: email, password: pass})
        });
        if (res.ok) {
            const data = await res.json();
            AppState.user = data.user;
            AppState.token = data.token;
            await AppState.fetchPosts();
            window.showToast('Logged in securely!');
            window.navigateTo('home');
        } else {
            window.showToast('Invalid credentials!');
        }
    } catch (e) {
        window.showToast('Server error!');
    }
};

window.signup = async function() {
    const email = document.getElementById('login-email').value;
    const pass = document.getElementById('login-pass').value;
    try {
        const res = await fetch('/api/signup', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                name: email.split('@')[0], 
                email: email,
                password: pass,
                branch: 'Computer Science',
                semester: '1st'
            })
        });
        if (res.ok) {
            window.showToast('Secure account created! Logging in...');
            window.login();
        } else {
            window.showToast('Email already exists.');
        }
    } catch (e) {
        window.showToast('Server error!');
    }
};

function renderLogin() {
    bottomNav.classList.add('hidden');
    mainContent.className = 'screen active';
    mainContent.innerHTML = `
        <div class="flex-col align-center justify-center" style="height: 100%; padding: var(--spacing-lg);">
            <div style="width: 80px; height: 80px; background-color: var(--bg-surface); border: 2px solid white; border-radius: 24px; margin-bottom: 24px; display: flex; align-items: center; justify-content: center; box-shadow: 0 10px 30px rgba(0,0,0,0.05); backdrop-filter: blur(10px);">
                <i data-lucide="shield-check" style="width: 40px; height: 40px; color: var(--accent-green-dark);"></i>
            </div>
            <h1 style="margin-bottom: 8px;">Studyogram</h1>
            <p class="mb-lg" style="text-align: center;">Enterprise-grade secure academic network.</p>
            
            <div class="card" style="width: 100%;">
                <div class="flex-col gap-md">
                    <input type="text" id="login-email" class="input-field" placeholder="Email">
                    <input type="password" id="login-pass" class="input-field" placeholder="Password">
                    <button class="btn" style="width: 100%; justify-content: center; margin-top: 8px;" onclick="window.login()">Secure Sign In</button>
                    <button class="btn btn-secondary" style="width: 100%; justify-content: center;" onclick="window.signup()">Create Account</button>
                </div>
            </div>
        </div>
    `;
    if (window.lucide) window.lucide.createIcons();
}

window.createNewPost = async function() {
    const title = prompt("Post Title:");
    if (!title) return;
    const content = prompt("Post Content:");
    await AppState.createPost(title, content, "doubt");
    window.showToast("Post Created securely!");
    window.navigateTo('home');
};

navItems.forEach(item => {
    item.addEventListener('click', (e) => {
        const btn = e.target.closest('.nav-item');
        if (btn) window.navigateTo(btn.dataset.target);
    });
});

AppState.subscribe(() => {
    const activeNav = document.querySelector('.nav-item.active');
    if (activeNav && AppState.user) {
        window.navigateTo(activeNav.dataset.target);
    }
});

function init() {
    if (window.lucide) window.lucide.createIcons();
    if (!AppState.user) renderLogin();
}

init();
