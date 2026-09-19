const createAsyncRouter = require('../asyncRouter');
const { db, nowStr } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = createAsyncRouter();
router.use(requireAuth);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
const SYSTEM_INSTRUCTION = 'You are Gemini, a helpful AI assistant built into NovaConnect, a team chat app. Keep answers concise and practical — this is a chat panel, not a document editor.';

// No GEMINI_API_KEY set yet — falls back to an honest placeholder rather than pretending
// to be a real assistant. Remove this branch entirely once a key is always expected.
const PLACEHOLDER_REPLIES = [
  "Gemini isn't connected yet — this is a placeholder reply. Ask your admin to add a GEMINI_API_KEY to turn this into a real assistant.",
  "I can't actually think yet — no API key is set. Once one is, I'll answer for real.",
  "Still just a placeholder here — no model behind me yet. Your message was saved though, so this conversation will make sense once I'm connected."
];
let placeholderIndex = 0;
function placeholderReply() {
  const reply = PLACEHOLDER_REPLIES[placeholderIndex % PLACEHOLDER_REPLIES.length];
  placeholderIndex++;
  return reply;
}

async function callGemini(history) {
  const contents = history.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.body }]
  }));

  const res = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents,
      systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] }
    })
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Gemini API error ${res.status}: ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts || [])
    .map(p => p.text || '').join('');
  if (!text) throw new Error('Gemini returned an empty response.');
  return text;
}

router.get('/api/ai/messages', async (req, res) => {
  const rows = await db.prepare('SELECT * FROM ai_messages WHERE user_id = ? ORDER BY id ASC').all(req.session.user.id);
  res.json({ messages: rows });
});

router.post('/api/ai/messages', async (req, res) => {
  const body = (req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Message cannot be empty.' });

  const userMsg = await db.prepare(`
    INSERT INTO ai_messages (user_id, role, body, created_at) VALUES (?, 'user', ?, ?) RETURNING *
  `).get(req.session.user.id, body, nowStr());

  let replyText;
  if (GEMINI_API_KEY) {
    try {
      const history = await db.prepare('SELECT role, body FROM ai_messages WHERE user_id = ? ORDER BY id ASC').all(req.session.user.id);
      replyText = await callGemini(history);
    } catch (e) {
      console.error('Gemini call failed:', e.message);
      replyText = "I couldn't reach Gemini just now (" + e.message + "). Try again in a moment.";
    }
  } else {
    replyText = placeholderReply();
  }

  const assistantMsg = await db.prepare(`
    INSERT INTO ai_messages (user_id, role, body, created_at) VALUES (?, 'assistant', ?, ?) RETURNING *
  `).get(req.session.user.id, replyText, nowStr());

  res.status(201).json({ userMessage: userMsg, assistantMessage: assistantMsg });
});

const REWRITE_STYLES = {
  concise: 'Rewrite the following text to be more concise, keeping the same meaning and key facts.',
  professional: 'Rewrite the following text to sound more professional and polished, suitable for a workplace chat.',
  friendly: 'Rewrite the following text to sound warmer and more friendly, while staying clear and professional.',
  grammar: 'Fix the grammar, spelling, and punctuation in the following text without changing its meaning, tone, or length.'
};

// A stateless one-shot rewrite — deliberately NOT saved to ai_messages, since this isn't
// part of the user's conversation with Gemini, it's a utility applied to composer drafts.
router.post('/api/ai/rewrite', async (req, res) => {
  const text = (req.body.text || '').trim();
  const style = REWRITE_STYLES[req.body.style] ? req.body.style : 'concise';
  if (!text) return res.status(400).json({ error: 'Nothing to rewrite.' });
  if (!GEMINI_API_KEY) return res.status(503).json({ error: "Gemini isn't connected yet — ask your admin to add a GEMINI_API_KEY." });

  try {
    const instruction = REWRITE_STYLES[style];
    const rewritten = await callGemini([
      { role: 'user', body: `${instruction} Reply with ONLY the rewritten text — no quotes, no preamble, no explanation.\n\nText:\n"""${text}"""` }
    ]);
    res.json({ rewritten: rewritten.trim() });
  } catch (e) {
    console.error('Gemini rewrite failed:', e.message);
    res.status(502).json({ error: "Couldn't reach Gemini just now. Try again in a moment." });
  }
});

router.post('/api/ai/clear', async (req, res) => {
  await db.prepare('DELETE FROM ai_messages WHERE user_id = ?').run(req.session.user.id);
  res.json({ ok: true });
});

module.exports = router;
