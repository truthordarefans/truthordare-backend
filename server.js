require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'tod_secret_change_me';
const BACKEND = process.env.BACKEND_URL || 'https://truthordare-backend.onrender.com';
const FRONTEND = process.env.FRONTEND_URL || 'https://www.truthordareformyfans.com';

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err.message));

// Schemas
const userSchema = new mongoose.Schema({
    name:        { type: String, required: true },
    email:       { type: String, required: true, unique: true, lowercase: true },
    passwordHash: { type: String, required: true },
    role:        { type: String, enum: ['fan', 'creator'], required: true },
    handle:      { type: String, default: null },
    bio:         { type: String, default: '' },
    photo:       { type: String, default: null },
    isLive:      { type: Boolean, default: false },
    featuredRequested: { type: Boolean, default: false },
    stripeAccountId: { type: String, default: null },
    createdAt:   { type: Date, default: Date.now },
});
const User = mongoose.model('User', userSchema);

const featuredSchema = new mongoose.Schema({
    name:        { type: String, required: true },
    email:       { type: String, required: true },
    bio:         { type: String, default: '' },
    platform:    { type: String, default: '' },
    photo:       { type: String, default: null },
    approved:    { type: Boolean, default: false },
    createdAt:   { type: Date, default: Date.now },
});
const Featured = mongoose.model('Featured', featuredSchema);

const chatSchema = new mongoose.Schema({
    roomId:      { type: String, required: true },
    name:        { type: String, required: true },
    role:        { type: String, required: true },
    message:     { type: String, required: true },
    createdAt:   { type: Date, default: Date.now },
});
const ChatMessage = mongoose.model('ChatMessage', chatSchema);

const bookingSchema = new mongoose.Schema({
    fanName:     { type: String, required: true },
    fanEmail:    { type: String, required: true },
    creatorName: { type: String, required: true },
    creatorEmail: { type: String, required: true },
    sessionType: { type: String, enum: ['truth', 'dare'], required: true },
    requestedDate: { type: String, required: true },
    proposedDate: { type: String, default: null },
    proposedTime: { type: String, default: null },
    status:      { type: String, enum: ['pending', 'accepted', 'declined', 'proposed', 'confirmed', 'expired'], default: 'pending' },
    paymentIntentId: { type: String, default: null },
    roomId:      { type: String, default: null },
    roomUrl:     { type: String, default: null },
    token:       { type: String, default: null },
    createdAt:   { type: Date, default: Date.now },
});
const Booking = mongoose.model('Booking', bookingSchema);

// Middleware for authentication
const requireAuth = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Authentication required.' });
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch (err) { return res.status(403).json({ error: 'Invalid token.' }); }
};

// Helper to calculate platform fee
const platformFee = (amount) => Math.round(amount * 0.15); // 15% platform fee

// Daily.co API for video rooms
const createDailyRoom = async (sessionType) => {
    const roomDuration = sessionType === 'truth' ? 5 : 15; // 5 min for truth, 15 min for dare
    const response = await fetch('https://api.daily.co/v1/rooms', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.DAILY_API_KEY}`,
        },
        body: JSON.stringify({
            properties: {
                max_participants: 2,
                enable_prejoin_ui: false,
                enable_knocking: false,
                enable_chat: true,
                start_video_off: true,
                start_audio_off: false,
                exp: Math.round(Date.now() / 1000) + (roomDuration * 60), // Room expires after duration
            },
        }),
    });
    if (!response.ok) throw new Error(`Daily.co API error: ${response.statusText}`);
    return response.json();
};

// Routes
app.post('/register', async (req, res) => {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password || !role) return res.status(400).json({ error: 'All fields required.' });
    try {
        const existingUser = await User.findOne({ email: email.toLowerCase() });
        if (existingUser) return res.status(409).json({ error: 'User already exists.' });
        const passwordHash = await bcrypt.hash(password, 10);
        const user = await User.create({ name, email: email.toLowerCase(), passwordHash, role });
        const token = jwt.sign({ userId: user._id, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
        res.status(201).json({ message: 'User registered.', token });
    } catch (err) { res.status(500).json({ error: 'Registration failed.' }); }
});

app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
    try {
        const user = await User.findOne({ email: email.toLowerCase() });
        if (!user) return res.status(401).json({ error: 'Invalid credentials.' });
        const isMatch = await bcrypt.compare(password, user.passwordHash);
        if (!isMatch) return res.status(401).json({ error: 'Invalid credentials.' });
        const token = jwt.sign({ userId: user._id, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
        res.json({ message: 'Logged in.', token, role: user.role, handle: user.handle });
    } catch (err) { res.status(500).json({ error: 'Login failed.' }); }
});

app.post('/create-checkout-session', async (req, res) => {
    const { selectedCard, creatorName, fanName, creatorStripeAccountId } = req.body;
    if (!selectedCard || !creatorName || !fanName) return res.status(400).json({ error: 'Missing fields.' });
    const PRICES = {
        truth: { amount: 1500, label: 'Truth Session' },
        dare:  { amount: 4500, label: 'Dare Session' },
    };
    const price = PRICES[selectedCard];
    if (!price) return res.status(400).json({ error: 'Invalid card.' });
    try {
        const sessionParams = {
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: price.label,
                        description: `Fan: ${fanName} · Creator: ${creatorName}`,
                    },
                    unit_amount: price.amount,
                },
                quantity: 1
            }],
            mode: 'payment',
            success_url: `${FRONTEND}?success=1`,
            cancel_url: `${FRONTEND}?canceled=1`,
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
        console.error('Stripe checkout session creation failed:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/onboard-creator', async (req, res) => {
    const { creatorEmail, creatorName } = req.body;
    try {
        const account = await stripe.accounts.create({
            type: 'express',
            email: creatorEmail,
            capabilities: { transfers: { requested: true } },
            business_profile: { name: creatorName, url: FRONTEND },
        });
        const accountLink = await stripe.accountLinks.create({
            account: account.id,
            refresh_url: `${FRONTEND}/onboard-refresh?account=${account.id}`,
            return_url: `${FRONTEND}/onboard-complete.html?account=${account.id}`,
            type: 'account_onboarding',
        });
        await User.findOneAndUpdate({ email: creatorEmail.toLowerCase() }, { stripeAccountId: account.id });
        res.json({ accountId: account.id, onboardingUrl: accountLink.url });
    } catch (err) {
        console.error('Stripe creator onboarding failed:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    }
    catch (err) {
        console.error('Stripe webhook error:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    // Handle the event
    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        console.log('Payment successful:', { sessionId: session.id, amount: session.amount_total, currency: session.currency });
        // Fulfill the purchase...
        // For now, just log it
        console.log('Payment:', { creator: session.metadata.creator, fan: session.metadata.fan, total: `$${(session.amount_total/100).toFixed(2)}` });
    }
    // Return a 200 response to acknowledge receipt of the event
    res.json({ received: true });
});

app.post('/featured-apply', async (req, res) => {
    const { name, email, bio, platform, photo } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name and email required.' });
    try {
        const existing = await Featured.findOne({ email: email.toLowerCase() });
        if (existing) return res.status(409).json({ error: 'Application already exists.' });
        await Featured.create({ name, email: email.toLowerCase(), bio: bio || '', platform: platform || '', photo: photo || null });
        // Optionally send an email notification to admin
        if (process.env.ADMIN_EMAIL) {
            // Assuming sendEmail function exists and is configured
            // await sendEmail(process.env.ADMIN_EMAIL, `⭐ New Creator Application: ${name}`, `<h2>New Application</h2><p><strong>Name:</strong> ${name}</p><p><strong>Email:</strong> ${email}</p><p><strong>Bio:</strong> ${bio || 'N/A'}</p>`);
        }
        res.json({ success: true });
    } catch (err) {
        console.error('Featured creator application failed:', err);
        res.status(500).json({ error: 'Submission failed.' });
    }
});

app.get('/featured-creators', async (req, res) => {
    try {
        const creators = await Featured.find({ approved: true }, { email: 0 }).sort({ createdAt: -1 });
        res.json({ creators });
    } catch (err) {
        console.error('Failed to fetch featured creators:', err);
        res.status(500).json({ error: 'Could not fetch.' });
    }
});

app.post('/featured-approve', requireAuth, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
    try {
        await Featured.findByIdAndUpdate(req.body.id, { approved: req.body.approved });
        res.json({ success: true });
    } catch (err) {
        console.error('Failed to approve featured creator:', err);
        res.status(500).json({ error: 'Could not update.' });
    }
});

app.post('/create-room', requireAuth, async (req, res) => {
    if (!process.env.DAILY_API_KEY) return res.status(500).json({ error: 'Daily.co not configured.' });
    try {
        const room = await createDailyRoom(req.body.sessionType);
        res.json({ roomId: room.name, url: room.url });
    } catch (err) {
        console.error('Failed to create Daily.co room:', err);
        res.status(500).json({ error: 'Could not create room.' });
    }
});

app.get('/get-room/:roomId', requireAuth, async (req, res) => {
    if (!process.env.DAILY_API_KEY) return res.status(500).json({ error: 'Daily.co not configured.' });
    try {
        const r = await fetch(`https://api.daily.co/v1/rooms/${req.params.roomId}`, {
            headers: { 'Authorization': `Bearer ${process.env.DAILY_API_KEY}` }
        });
        res.json({ url: (await r.json()).url });
    } catch (err) {
        console.error('Failed to fetch Daily.co room:', err);
        res.status(500).json({ error: 'Could not fetch room.' });
    }
});

app.post('/room-chat/:roomId', requireAuth, async (req, res) => {
    if (!req.body.message) return res.status(400).json({ error: 'Message required.' });
    try {
        await ChatMessage.create({ roomId: req.params.roomId, name: req.body.name, role: req.body.role, message: req.body.message });
        res.json({ success: true });
    } catch (err) {
        console.error('Failed to save chat message:', err);
        res.status(500).json({ error: 'Could not save.' });
    }
});

app.get('/room-chat/:roomId', async (req, res) => {
    const since = parseInt(req.query.since) || 0;
    try {
        const messages = await ChatMessage.find({ roomId: req.params.roomId }).sort({ createdAt: 1 });
        res.json({ messages: messages.slice(since) });
    } catch (err) {
        console.error('Failed to fetch chat messages:', err);
        res.status(500).json({ error: 'Could not fetch.' });
    }
});

// ── CREATOR DASHBOARD ENDPOINTS ──────────────────────────────────────────────

// GET /creator/profile — returns the logged-in creator's profile
app.get('/creator/profile', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId).select('-passwordHash');
        if (!user) return res.status(404).json({ error: 'User not found.' });
        if (user.role !== 'creator') return res.status(403).json({ error: 'Creator only.' });
        res.json({ user });
    } catch (err) {
        console.error('Failed to fetch creator profile:', err);
        res.status(500).json({ error: 'Could not fetch profile.' });
    }
});

// PUT /creator/profile — update name, bio, photo, handle
app.put('/creator/profile', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        if (!user) return res.status(404).json({ error: 'User not found.' });
        if (user.role !== 'creator') return res.status(403).json({ error: 'Creator only.' });
        const { name, bio, photo, handle } = req.body;
        if (name) user.name = name;
        if (bio !== undefined) user.bio = bio;
        if (photo !== undefined) user.photo = photo;
        if (handle) user.handle = handle.startsWith('@') ? handle : '@' + handle;
        await user.save();
        res.json({ success: true, user: { name: user.name, bio: user.bio, photo: user.photo, handle: user.handle } });
    } catch (err) {
        console.error('Failed to update creator profile:', err);
        res.status(500).json({ error: 'Could not update profile.' });
    }
});

// PUT /creator/availability — toggle live/offline status
app.put('/creator/availability', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        if (!user || user.role !== 'creator') return res.status(403).json({ error: 'Creator only.' });
        user.isLive = req.body.isLive === true;
        await user.save();
        console.log(`Creator ${user.name} is now ${user.isLive ? 'LIVE 🔴' : 'OFFLINE ⚫'}`);
        res.json({ success: true, isLive: user.isLive });
    } catch (err) {
        console.error('Failed to update availability:', err);
        res.status(500).json({ error: 'Could not update availability.' });
    }
});

// POST /creator/feature-request — request to be featured on homepage
app.post('/creator/feature-request', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        if (!user || user.role !== 'creator') return res.status(403).json({ error: 'Creator only.' });
        const { bio, photo } = req.body;
        // Update user's featured request fields
        user.featuredRequested = true;
        if (bio !== undefined) user.bio = bio;
        if (photo !== undefined) user.photo = photo;
        await user.save();
        // Create or update Featured entry (pending approval)
        const existing = await Featured.findOne({ email: user.email });
        if (existing) {
            existing.name = user.name;
            existing.bio = user.bio || '';
            existing.photo = user.photo || null;
            existing.approved = false; // Reset to pending on re-apply
            await existing.save();
        } else {
            await Featured.create({ name: user.name, email: user.email, bio: user.bio || '', photo: user.photo || null });
        }
        console.log(`⭐ Creator ${user.name} requested to be featured — pending admin approval.`);
        res.json({ success: true, message: 'Feature request submitted. Pending admin approval.' });
    } catch (err) {
        console.error('Failed to submit feature request:', err);
        res.status(500).json({ error: 'Could not submit request.' });
    }
});

// DELETE /creator/feature-request — remove from featured
app.delete('/creator/feature-request', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        if (!user || user.role !== 'creator') return res.status(403).json({ error: 'Creator only.' });
        user.featuredRequested = false;
        await user.save();
        await Featured.findOneAndDelete({ email: user.email });
        res.json({ success: true, message: 'Removed from featured.' });
    } catch (err) {
        console.error('Failed to remove feature request:', err);
        res.status(500).json({ error: 'Could not remove.' });
    }
});

// GET /creator/sessions — returns sessions for the logged-in creator
app.get('/creator/sessions', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        if (!user || user.role !== 'creator') return res.status(403).json({ error: 'Creator only.' });
        const sessions = await Booking.find({ creatorEmail: user.email }).sort({ createdAt: -1 }).limit(50);
        res.json({ sessions });
    } catch (err) {
        console.error('Failed to fetch creator sessions:', err);
        res.status(500).json({ error: 'Could not fetch sessions.' });
    }
});

// GET /creator/earnings — returns earnings summary for the logged-in creator
app.get('/creator/earnings', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        if (!user || user.role !== 'creator') return res.status(403).json({ error: 'Creator only.' });
        const sessions = await Booking.find({ creatorEmail: user.email, status: { $in: ['confirmed', 'accepted'] } });
        const PRICES = { truth: 1500, dare: 4500 };
        const totalGross = sessions.reduce((sum, s) => sum + (PRICES[s.sessionType] || 0), 0);
        const totalEarnings = Math.round(totalGross * 0.85); // 85% to creator
        res.json({
            totalSessions: sessions.length,
            totalGrossUSD: (totalGross / 100).toFixed(2),
            totalEarningsUSD: (totalEarnings / 100).toFixed(2),
            stripeConnected: !!user.stripeAccountId,
            stripeAccountId: user.stripeAccountId || null,
        });
    } catch (err) {
        console.error('Failed to fetch creator earnings:', err);
        res.status(500).json({ error: 'Could not fetch earnings.' });
    }
});

// ── END CREATOR DASHBOARD ENDPOINTS ───────────────────────────────────────────

app.get('/', (req, res) => res.send('truthordareformyfans.com backend ✓'));

app.listen(PORT, () => {
    console.log(`\n🎯 Server running at http://localhost:${PORT}`);
    console.log(`   Stripe: ${process.env.STRIPE_SECRET_KEY?.startsWith('sk_live') ? 'LIVE 🔴' : 'TEST ✅'}`);
    console.log(`   Split: 85% creator / 15% platform\n`);
});
