require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const stripe   = require('stripe')(process.env.STRIPE_SECRET_KEY);
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const mongoose = require('mongoose');

const app  = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'tod_secret_change_me';

app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

// ── MongoDB Connection ────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ MongoDB connected'))
    .catch(err => console.error('❌ MongoDB error:', err.message));

// ── User Schema ───────────────────────────────────────────────────
const userSchema = new mongoose.Schema({
    name:            { type: String, required: true },
    email:           { type: String, required: true, unique: true, lowercase: true },
    passwordHash:    { type: String, required: true },
    role:            { type: String, enum: ['fan', 'creator'], required: true },
    handle:          { type: String, default: null },
    stripeAccountId: { type: String, default: null },
    createdAt:       { type: Date, default: Date.now },
});
const User = mongoose.model('User', userSchema);

const PRICES = {
    truth: { amount: 1500, label: 'Truth — 5 Minute Session'    },
    dare:  { amount: 4500, label: 'Dare — 15 Minute Live Stream' },
};

function platformFee(amount) { return Math.round(amount * 0.15); }

// ── POST /register ────────────────────────────────────────────────
app.post('/register', async (req, res) => {
    const { name, email, password, role, handle } = req.body;
    if (!name || !email || !password || !role)
        return res.status(400).json({ error: 'Missing required fields.' });
    if (password.length < 6)
        return res.status(400).json({ error: 'Password must be at least 6 characters.' });

    try {
        const existing = await User.findOne({ email: email.toLowerCase() });
        if (existing)
            return res.status(409).json({ error: 'An account with this email already exists.' });

        const passwordHash = await bcrypt.hash(password, 10);
        const user = await User.create({ name, email, passwordHash, role, handle: handle || null });

        const token    = jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
        const safeUser = { id: user._id, name: user.name, email: user.email, role: user.role, handle: user.handle, stripeAccountId: user.stripeAccountId };
        console.log(`✅ New ${role} registered: ${name} (${email})`);
        res.json({ token, user: safeUser });
    } catch (err) {
        console.error('Register error:', err.message);
        res.status(500).json({ error: 'Registration failed. Please try again.' });
    }
});

// ── POST /login ───────────────────────────────────────────────────
app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password)
        return res.status(400).json({ error: 'Email and password are required.' });

    try {
        const user = await User.findOne({ email: email.toLowerCase() });
        if (!user)
            return res.status(401).json({ error: 'No account found with this email.' });

        const match = await bcrypt.compare(password, user.passwordHash);
        if (!match)
            return res.status(401).json({ error: 'Incorrect password.' });

        const token    = jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
        const safeUser = { id: user._id, name: user.name, email: user.email, role: user.role, handle: user.handle, stripeAccountId: user.stripeAccountId };
        console.log(`✅ Login: ${user.name} (${user.role})`);
        res.json({ token, user: safeUser });
    } catch (err) {
        console.error('Login error:', err.message);
        res.status(500).json({ error: 'Login failed. Please try again.' });
    }
});

// ── Auth middleware ───────────────────────────────────────────────
function requireAuth(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Not authenticated.' });
    try { req.user = jwt.verify(auth.split(' ')[1], JWT_SECRET); next(); }
    catch { res.status(401).json({ error: 'Session expired. Please log in again.' }); }
}

// ── GET /me ───────────────────────────────────────────────────────
app.get('/me', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ error: 'User not found.' });
        res.json({ id: user._id, name: user.name, email: user.email, role: user.role, handle: user.handle, stripeAccountId: user.stripeAccountId });
    } catch (err) {
        res.status(500).json({ error: 'Could not fetch user.' });
    }
});

// ── POST /create-checkout-session ────────────────────────────────
app.post('/create-checkout-session', async (req, res) => {
    const { selectedCar
