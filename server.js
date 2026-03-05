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

mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ MongoDB connected'))
    .catch(err => console.error('❌ MongoDB error:', err.message));

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

const featuredSchema = new mongoose.Schema({
    name:      { type: String, required: true },
    email:     { type: String, required: true },
    bio:       { type: String, default: '' },
    platform:  { type: String, default: '' },
    photo:     { type: String, default: null },
    approved:  { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
});
const Featured = mongoose.model('Featured', featuredSchema);

const chatSchema = new mongoose.Schema({
    roomId:    { type: String, required: true },
    name:      { type: String, required: true },
    role:      { type: String, required: true },
    message:   { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
});
const ChatMessage = mongoose.model('ChatMessage', chatSchema);

const PRICES = {
    truth: { amount: 1500, label: 'Truth — 5 Minute Session' },
    dare:  { amount: 4500, label: 'Dare — 15 Minute Live Stream' },
};

function platformFee(amount) { return Math.round(amount * 0.15); }

function requireAuth(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Not authenticated.' });
    try { req.user = jwt.verify(auth.split(' ')[1], JWT_SECRET); next(); }
    catch { res.status(401).json({ error: 'Session expired. Please log in again.' }); }
}

app.post('/register', async (req, res) => {
    const { name, email, password, role, handle } = req.body;
    if (!name || !email || !password || !role) return res.status(400).json({ error: 'Missing required fields.' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    try {
        const existing = await User.findOne({ email: email.toLowerCase() });
        if (existing) return res.status(409).json({ error: 'An account with this email already exists.' });
        const passwordHash = await bcrypt.hash(password, 10);
        const user = await User.create({ name, email, passwordHash, role, handle: handle || null });
        const token = jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
        const safeUser = { id: user._id, name: user.name, email: user.email, role: user.role, handle: user.handle, stripeAccountId: user.stripeAccountId };
        console.log(`✅ New ${role} registered: ${name} (${email})`);
        res.json({ token, user: safeUser });
    } catch (err) {
        console.error('Register error:', err.message);
        res.status(500).json({ error: 'Registration failed. Please try again.' });
    }
});

app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
    try {
        const user = await User.findOne({ email: email.toLowerCase() });
        if (!user) return res.status(401).json({ error: 'No account found with this email.' });
        const match = await bcrypt.compare(password, user.passwordHash);
        if (!match) return res.status(401).json({ error: 'Incorrect password.' });
        const token = jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
        const safeUser = { id: user._id, name: user.name, email: user.email, role: user.role, handle: user.handle, stripeAccountId: user.stripeAccountId };
        console.log(`✅ Login: ${user.name} (${user.role})`);
        res.json({ token, user: safeUser });
    } catch (err) {
        console.error('Login error:', err.message);
        res.status(500).json({ error: 'Login failed. Please try again.' });
    }
});

app.get('/me', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ error: 'User not found.' });
        res.json({ id: user._id, name: user.name, email: user.email, role: user.role, handle: user.handle, stripeAccountId: user.stripeAccountId });
    } catch (err) {
        res.status(500).json({ error: 'Could not fetch user.' });
    }
});

app.post('/create-checkout-session', async (req, res) => {
    const { selectedCard, creatorName, fanName, creatorStripeAccountId } = req.body;
    if (!selectedCard || !creatorName || !fanName) return res.status(400).json({ error: 'Missing required fields.' });
    const price = PRICES[selectedCard];
    if (!price) return res.status(400).json({ error: 'Invalid card selection.' });
    try {
        const sessionParams = {
            payment_method_types: ['card'],
            line_items: [{ price_data: { currency: 'cad', product_data: { name: price.label, description: `Fan: ${fanName}  ·  Creator: ${creatorName}` }, unit_amount: price.amount }, quantity: 1 }],
            mode: 'payment',
            success_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}?success=1`,
            cancel_url:  `${process.env.FRONTEND_URL || 'http://localhost:3000'}?canceled=1`,
            metadata: { creator: creatorName, fan: fanName, type: selectedCard },
        };
        if (creatorStripeAccountId) {
            sessionParams.payment_intent_data = {
                application_fee_amount: platformFee(price.amount),
                transfer_data: { destination: creatorStripeAccountId },
            };
        }
        const session = await stripe.checkout.sessions.create(sessionParams);
        res.json({ url: session.url });
    } catch (err) {
        console.error('Stripe error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/onboard-creator', async (req, res) => {
    const { creatorEmail, creatorName } = req.body;
    try {
        const account = await stripe.accounts.create({
            type: 'express', email: creatorEmail,
            capabilities: { transfers: { requested: true } },
            business_profile: { name: creatorName, url: process.env.FRONTEND_URL || 'https://truthordareformyfans.com' },
        });
        const accountLink = await stripe.accountLinks.create({
            account:     account.id,
            refresh_url: `${process.env.FRONTEND_URL}/onboard-refresh?account=${account.id}`,
            return_url:  `${process.env.FRONTEND_URL}/onboard-complete.html?account=${account.id}`,
            type:        'account_onboarding',
        });
        await User.findOneAndUpdate({ email: creatorEmail.toLowerCase() }, { stripeAccountId: account.id });
        console.log(`✅ Creator Stripe connected: ${creatorName} → ${account.id}`);
        res.json({ accountId: account.id, onboardingUrl: accountLink.url });
    } catch (err) {
        console.error('Onboarding error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try { event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET); }
    catch (err) { return res.status(400).send(`Webhook Error: ${err.message}`); }
    if (event.type === 'checkout.session.completed') {
        const s = event.data.object;
        const total = s.amount_total;
        const fee = platformFee(total);
        console.log('💰 Payment:', { creator: s.metadata.creator, fan: s.metadata.fan, type: s.metadata.type, total: `$${(total/100).toFixed(2)}`, platform: `$${(fee/100).toFixed(2)}`, creator_payout: `$${((total-fee)/100).toFixed(2)}` });
    }
    res.json({ received: true });
});

app.post('/featured-apply', async (req, res) => {
    const { name, email, bio, platform, photo } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name and email are required.' });
    try {
        const existing = await Featured.findOne({ email: email.toLowerCase() });
        if (existing) return res.status(409).json({ error: 'An application with this email already exists.' });
        await Featured.create({ name, email: email.toLowerCase(), bio: bio || '', platform: platform || '', photo: photo || null });
        console.log(`⭐ Featured creator applied: ${name} (${email})`);
        if (process.env.ADMIN_EMAIL) {
            const nodemailer = require('nodemailer');
            const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } });
            await transporter.sendMail({ from: process.env.EMAIL_USER, to: process.env.ADMIN_EMAIL, subject: `⭐ New Featured Creator Application: ${name}`, html: `<h2>New Featured Creator Application</h2><p><strong>Name:</strong> ${name}</p><p><strong>Email:</strong> ${email}</p><p><strong>Bio:</strong> ${bio || 'N/A'}</p><p><strong>Platform:</strong> ${platform || 'N/A'}</p>` }).catch(e => console.error('Email error:', e.message));
        }
        res.json({ success: true });
    } catch (err) {
        console.error('Featured apply error:', err.message);
        res.status(500).json({ error: 'Submission failed. Please try again.' });
    }
});

app.get('/featured-creators', async (req, res) => {
    try {
        const creators = await Featured.find({ approved: true }, { email: 0 }).sort({ createdAt: -1 });
        res.json({ creators });
    } catch (err) {
        res.status(500).json({ error: 'Could not fetch creators.' });
    }
});

app.post('/featured-approve', requireAuth, async (req, res) => {
    const { id, approved } = req.body;
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
    try {
        await Featured.findByIdAndUpdate(id, { approved });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Could not update.' });
    }
});

app.post('/create-room', requireAuth, async (req, res) => {
    const { sessionType } = req.body;
    if (!process.env.DAILY_API_KEY) return res.status(500).json({ error: 'Daily.co not configured.' });
    try {
        const expiry = Math.floor(Date.now() / 1000) + (sessionType === 'dare' ? 20 : 10) * 60;
        const response = await fetch('https://api.daily.co/v1/rooms', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.DAILY_API_KEY}` },
            body: JSON.stringify({ properties: { exp: expiry, enable_chat: false, enable_screenshare: false, start_video_off: false, start_audio_off: false, max_participants: 2 } })
        });
        const room = await response.json();
        res.json({ roomId: room.name, url: room.url });
    } catch (err) {
        console.error('Daily.co error:', err.message);
        res.status(500).json({ error: 'Could not create room.' });
    }
});

app.get('/get-room/:roomId', requireAuth, async (req, res) => {
    if (!process.env.DAILY_API_KEY) return res.status(500).json({ error: 'Daily.co not configured.' });
    try {
        const response = await fetch(`https://api.daily.co/v1/rooms/${req.params.roomId}`, { headers: { 'Authorization': `Bearer ${process.env.DAILY_API_KEY}` } });
        const room = await response.json();
        res.json({ url: room.url });
    } catch (err) {
        res.status(500).json({ error: 'Could not fetch room.' });
    }
});

app.post('/room-chat/:roomId', requireAuth, async (req, res) => {
    const { message, name, role } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required.' });
    try {
        await ChatMessage.create({ roomId: req.params.roomId, name, role, message });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Could not save message.' });
    }
});

app.get('/room-chat/:roomId', async (req, res) => {
    const since = parseInt(req.query.since) || 0;
    try {
        const messages = await ChatMessage.find({ roomId: req.params.roomId }).sort({ createdAt: 1 });
        res.json({ messages: messages.slice(since) });
    } catch (err) {
        res.status(500).json({ error: 'Could not fetch messages.' });
    }
});

app.get('/', (req, res) => res.send('truthordareformyfans.com backend ✓'));

app.listen(PORT, () => {
    console.log(`\n🎯 Server running at http://localhost:${PORT}`);
    console.log(`   Stripe: ${process.env.STRIPE_SECRET_KEY?.startsWith('sk_live') ? 'LIVE 🔴' : 'TEST ✅'}`);
    console.log(`   Split: 85% creator / 15% platform\n`);
});
