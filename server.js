require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

// Email transporter (uses Gmail via app password or SMTP env vars)
const emailTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER || 'truthordarefans@gmail.com',
        pass: process.env.EMAIL_PASS,  // App password set in Render env vars
    },
});
async function sendEmail(to, subject, html) {
    if (!process.env.EMAIL_PASS) { console.warn('EMAIL_PASS not set — skipping email'); return; }
    try {
        await emailTransporter.sendMail({ from: '"Truth or Dare For My Fans" <truthordarefans@gmail.com>', to, subject, html });
        console.log(`📧 Email sent to ${to}: ${subject}`);
    } catch (err) { console.error('Email send error:', err.message); }
}

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
    name:        { type: String, required: true },       // Display / stage name (public)
    legalName:   { type: String, default: null },        // Legal name (private, for Stripe)
    email:       { type: String, required: true, unique: true, lowercase: true },
    passwordHash: { type: String, required: true },
    role:        { type: String, enum: ['fan', 'creator'], required: true },
    handle:      { type: String, default: null },
    bio:         { type: String, default: '' },
    photo:       { type: String, default: null },
    isLive:      { type: Boolean, default: false },
    inSession:   { type: Boolean, default: false },
    featuredRequested: { type: Boolean, default: false },
    stripeAccountId: { type: String, default: null },
    socials: {
        instagram:  { type: String, default: null },
        onlyfans:   { type: String, default: null },
        fansly:     { type: String, default: null },
        fansvue:    { type: String, default: null },
        luvelyfans: { type: String, default: null },
        tiktok:     { type: String, default: null },
    },
    extraPhotos: { type: [String], default: [] },
    notificationPrefs: {
        email:       { type: Boolean, default: true },
        sms:         { type: Boolean, default: false },
        phone:       { type: String, default: null },   // phone number for SMS
        customHandle: { type: String, default: null },  // e.g. "DM me on Instagram @zara"
    },
    createdAt:   { type: Date, default: Date.now },
    resetToken:  { type: String, default: null },
    resetTokenExpiry: { type: Date, default: null },
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
// Handle availability check
app.get('/check-handle/:handle', async (req, res) => {
    try {
        const raw = req.params.handle.replace(/^@/, '').replace(/@truthordare$/i, '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
        if (!raw || raw.length < 3) return res.json({ available: false, reason: 'Handle must be at least 3 characters.' });
        if (raw.length > 20) return res.json({ available: false, reason: 'Handle must be 20 characters or less.' });
        const fullHandle = `${raw}@truthordare`;
        const existing = await User.findOne({ handle: fullHandle });
        if (existing) return res.json({ available: false, reason: 'That handle is already taken.' });
        return res.json({ available: true, handle: fullHandle });
    } catch (err) { res.status(500).json({ available: false, reason: 'Server error.' }); }
});

app.post('/register', async (req, res) => {
    const { name, legalName, email, password, role, handle, socials, notificationPrefs } = req.body;
    if (!name || !email || !password || !role) return res.status(400).json({ error: 'All fields required.' });
    try {
        const existingUser = await User.findOne({ email: email.toLowerCase() });
        if (existingUser) return res.status(409).json({ error: 'User already exists.' });
        const passwordHash = await bcrypt.hash(password, 10);
        // Format handle as name@truthordare (strip any leading @ or existing @truthordare suffix)
        let handleFormatted = null;
        if (handle) {
            let h = handle.replace(/^@/, '').replace(/@truthordare$/i, '').trim().toLowerCase().replace(/\s+/g, '');
            handleFormatted = h ? `${h}@truthordare` : null;
        }
        // Build notification prefs (default to email if not provided)
        const notifPrefs = {
            email: notificationPrefs?.email !== false,
            sms: !!notificationPrefs?.sms,
            phone: notificationPrefs?.phone || null,
            customHandle: notificationPrefs?.customHandle || null,
        };
        const user = await User.create({ name, legalName: legalName || null, email: email.toLowerCase(), passwordHash, role, handle: handleFormatted, socials: socials || {}, notificationPrefs: notifPrefs });
        const token = jwt.sign({ userId: user._id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
        res.status(201).json({ message: 'User registered.', token, role: user.role, handle: user.handle });
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
    const { selectedCard, creatorName, fanName, creatorStripeAccountId, fanEmail, bookingDate, bookingTime, note } = req.body;
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
            metadata: { creator: creatorName, fan: fanName, type: selectedCard, bookingDate: bookingDate || '', bookingTime: bookingTime || '', note: note || '' },
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
    if (!creatorEmail || !creatorName) return res.status(400).json({ error: 'Email and name required.' });
    try {
        const user = await User.findOne({ email: creatorEmail.toLowerCase() });
        let accountId = user?.stripeAccountId || null;

        // If creator already has an account, generate a new onboarding link for it
        // (handles the case where they started but didn't finish)
        if (!accountId) {
            const account = await stripe.accounts.create({
                type: 'express',
                email: creatorEmail,
                capabilities: { transfers: { requested: true } },
                business_profile: { name: creatorName, url: FRONTEND },
            });
            accountId = account.id;
            await User.findOneAndUpdate({ email: creatorEmail.toLowerCase() }, { stripeAccountId: accountId });
        }

        // Check if already fully onboarded
        const account = await stripe.accounts.retrieve(accountId);
        if (account.details_submitted && account.charges_enabled) {
            // Already fully connected — return a dashboard link instead
            const loginLink = await stripe.accounts.createLoginLink(accountId);
            return res.json({ accountId, onboardingUrl: loginLink.url, alreadyConnected: true });
        }

        // Generate fresh onboarding link
        const accountLink = await stripe.accountLinks.create({
            account: accountId,
            refresh_url: `${FRONTEND}/onboard-refresh.html?account=${accountId}`,
            return_url: `${FRONTEND}/onboard-complete.html?account=${accountId}`,
            type: 'account_onboarding',
        });
        res.json({ accountId, onboardingUrl: accountLink.url, alreadyConnected: false });
    } catch (err) {
        console.error('Stripe creator onboarding failed:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET /stripe-account-status — check if a creator's Stripe account is fully onboarded
app.get('/stripe-account-status', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        if (!user || user.role !== 'creator') return res.status(403).json({ error: 'Creator only.' });
        if (!user.stripeAccountId) {
            return res.json({ connected: false, detailsSubmitted: false, chargesEnabled: false, payoutsEnabled: false });
        }
        const account = await stripe.accounts.retrieve(user.stripeAccountId);
        const fullyConnected = account.details_submitted && account.charges_enabled;
        res.json({
            connected: fullyConnected,
            detailsSubmitted: account.details_submitted,
            chargesEnabled: account.charges_enabled,
            payoutsEnabled: account.payouts_enabled,
            accountId: user.stripeAccountId,
        });
    } catch (err) {
        console.error('Failed to fetch Stripe account status:', err);
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
        const { creator: creatorName, fan: fanName, type: sessionType, bookingDate, bookingTime } = session.metadata || {};
        const fanEmail = session.customer_details?.email || session.metadata?.fanEmail || '';
        console.log(`✅ Payment confirmed: ${fanName} booked ${sessionType} with ${creatorName} — $${(session.amount_total/100).toFixed(2)}`);

        // Run async post-payment fulfillment (don't await — respond to Stripe immediately)
        (async () => {
            try {
                // 1. Find the creator in the DB to get their email
                const creator = await User.findOne({ name: creatorName, role: 'creator' });
                const creatorEmail = creator ? creator.email : null;
                const creatorHandle = creator ? creator.handle : '';
                const sessionLabel = sessionType === 'truth' ? 'Truth Session ($15)' : 'Dare Session ($45)';
                const sessionMinutes = sessionType === 'truth' ? 5 : 15;
                const frontendUrl = process.env.FRONTEND_URL || 'https://www.truthordareformyfans.com';

                // 2. Create a Daily.co video room
                let roomUrl = null;
                let roomId = null;
                if (process.env.DAILY_API_KEY) {
                    try {
                        const room = await createDailyRoom(sessionType);
                        roomUrl = room.url;
                        roomId = room.name;
                        console.log(`🎥 Daily.co room created: ${roomUrl}`);
                    } catch (e) {
                        console.error('Daily.co room creation failed:', e.message);
                    }
                }

                const roomLink = roomUrl
                    ? `${frontendUrl}/room?id=${roomId}&creator=${encodeURIComponent(creatorHandle)}&type=${sessionType}`
                    : null;

                // 3. Email the creator
                if (creatorEmail) {
                    const creatorHtml = `
                        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#0d0000;color:#C9B99A;padding:32px;border-radius:12px;border:1px solid rgba(212,165,116,0.3);">
                            <h2 style="color:#D4A574;font-size:22px;margin-bottom:8px;">🎯 New Booking — ${sessionLabel}</h2>
                            <p style="font-size:15px;margin-bottom:16px;">A fan just paid and is ready for their session with you!</p>
                            <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
                                <tr><td style="padding:8px 0;color:#9A8A72;font-size:13px;">Fan name</td><td style="padding:8px 0;color:#FDF6EC;font-weight:700;">${fanName}</td></tr>
                                <tr><td style="padding:8px 0;color:#9A8A72;font-size:13px;">Fan email</td><td style="padding:8px 0;color:#FDF6EC;">${fanEmail}</td></tr>
                                <tr><td style="padding:8px 0;color:#9A8A72;font-size:13px;">Session type</td><td style="padding:8px 0;color:#FDF6EC;">${sessionLabel} (${sessionMinutes} min)</td></tr>
                                <tr><td style="padding:8px 0;color:#9A8A72;font-size:13px;">Requested date</td><td style="padding:8px 0;color:#FDF6EC;">${bookingDate || 'Flexible'}</td></tr>
                                <tr><td style="padding:8px 0;color:#9A8A72;font-size:13px;">Requested time</td><td style="padding:8px 0;color:#FDF6EC;">${bookingTime || 'Flexible'}</td></tr>
                            </table>
                            ${roomLink ? `<a href="${roomLink}" style="display:inline-block;background:#D4A574;color:#120500;padding:14px 28px;border-radius:8px;font-weight:700;font-size:15px;text-decoration:none;margin-bottom:16px;">▶ Start Session Now</a>` : '<p style="color:#9A8A72;font-size:13px;">Log into your dashboard to start the session.</p>'}
                            <p style="font-size:12px;color:#9A8A72;margin-top:20px;">Log into your <a href="${frontendUrl}/dashboard" style="color:#D4A574;">creator dashboard</a> to manage this booking.</p>
                        </div>`;
                    await sendEmail(creatorEmail, `🎯 New ${sessionLabel} booked by ${fanName}`, creatorHtml);
                }

                // 4. Email the fan
                if (fanEmail) {
                    const fanHtml = `
                        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#0d0000;color:#C9B99A;padding:32px;border-radius:12px;border:1px solid rgba(212,165,116,0.3);">
                            <h2 style="color:#D4A574;font-size:22px;margin-bottom:8px;">✅ Your booking is confirmed!</h2>
                            <p style="font-size:15px;margin-bottom:16px;">Your <strong style="color:#FDF6EC;">${sessionLabel}</strong> with <strong style="color:#FDF6EC;">${creatorName}</strong> is booked and paid.</p>
                            <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
                                <tr><td style="padding:8px 0;color:#9A8A72;font-size:13px;">Session</td><td style="padding:8px 0;color:#FDF6EC;font-weight:700;">${sessionLabel} (${sessionMinutes} min)</td></tr>
                                <tr><td style="padding:8px 0;color:#9A8A72;font-size:13px;">Creator</td><td style="padding:8px 0;color:#FDF6EC;">${creatorName}</td></tr>
                                <tr><td style="padding:8px 0;color:#9A8A72;font-size:13px;">Requested date</td><td style="padding:8px 0;color:#FDF6EC;">${bookingDate || 'Flexible'}</td></tr>
                                <tr><td style="padding:8px 0;color:#9A8A72;font-size:13px;">Requested time</td><td style="padding:8px 0;color:#FDF6EC;">${bookingTime || 'Flexible'}</td></tr>
                            </table>
                            ${roomLink ? `<a href="${roomLink}" style="display:inline-block;background:#D4A574;color:#120500;padding:14px 28px;border-radius:8px;font-weight:700;font-size:15px;text-decoration:none;margin-bottom:16px;">▶ Join Your Session</a>` : '<p style="color:#9A8A72;font-size:13px;">The creator will send you a session link shortly.</p>'}
                            <p style="font-size:12px;color:#9A8A72;margin-top:20px;">Questions? Reply to this email or visit <a href="${frontendUrl}" style="color:#D4A574;">truthordareformyfans.com</a></p>
                        </div>`;
                    await sendEmail(fanEmail, `✅ Your ${sessionLabel} with ${creatorName} is confirmed`, fanHtml);
                }

                console.log(`📧 Post-payment emails sent — creator: ${creatorEmail}, fan: ${fanEmail}`);
            } catch (err) {
                console.error('Post-payment fulfillment error:', err.message);
            }
        })();
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
        const { name, bio, photo, handle, extraPhotos, socials, notificationPrefs } = req.body;
        if (name) user.name = name;
        if (bio !== undefined) user.bio = bio;
        if (photo !== undefined) user.photo = photo;
        if (extraPhotos !== undefined) user.extraPhotos = extraPhotos.slice(0, 4); // max 4 extra photos
        if (handle) {
            let h = handle.replace(/^@/, '').replace(/@truthordare$/i, '').trim().toLowerCase().replace(/\s+/g, '');
            user.handle = h ? `${h}@truthordare` : user.handle;
        }
        if (socials) {
            user.socials = { ...user.socials, ...socials };
        }
        if (notificationPrefs) {
            user.notificationPrefs = {
                email: notificationPrefs.email !== undefined ? !!notificationPrefs.email : (user.notificationPrefs?.email ?? true),
                sms: notificationPrefs.sms !== undefined ? !!notificationPrefs.sms : (user.notificationPrefs?.sms ?? false),
                phone: notificationPrefs.phone !== undefined ? notificationPrefs.phone : (user.notificationPrefs?.phone ?? null),
                customHandle: notificationPrefs.customHandle !== undefined ? notificationPrefs.customHandle : (user.notificationPrefs?.customHandle ?? null),
            };
        }
        await user.save();
        res.json({ success: true, user: { name: user.name, bio: user.bio, photo: user.photo, handle: user.handle, extraPhotos: user.extraPhotos || [], socials: user.socials || {}, notificationPrefs: user.notificationPrefs || {} } });
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

// PUT /creator/session-status — set inSession true/false (called by room.html)
app.put('/creator/session-status', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        if (!user || user.role !== 'creator') return res.status(403).json({ error: 'Creator only.' });
        user.inSession = req.body.inSession === true;
        await user.save();
        console.log(`Creator ${user.name} is now ${user.inSession ? 'IN SESSION 🔴' : 'NOT in session'}`);
        res.json({ success: true, inSession: user.inSession });
    } catch (err) {
        res.status(500).json({ error: 'Could not update session status.' });
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
        if (extraPhotos !== undefined) user.extraPhotos = extraPhotos.slice(0, 4); // max 4 extra photos
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

// ── BOOKING ENDPOINTS ─────────────────────────────────────────────────────────

// POST /booking — fan submits a booking request after payment
app.post('/booking', async (req, res) => {
    const { fanName, fanEmail, creatorHandle, sessionType, requestedDate, requestedTime, note, paymentIntentId } = req.body;
    if (!fanName || !fanEmail || !creatorHandle || !sessionType || !requestedDate || !requestedTime) {
        return res.status(400).json({ error: 'Missing required booking fields.' });
    }
    try {
        // Handle format is name@truthordare — normalise by stripping leading @ if present
        const normalizedHandle = creatorHandle.replace(/^@/, '');
        const creator = await User.findOne({ handle: normalizedHandle });
        if (!creator) return res.status(404).json({ error: 'Creator not found.' });
        const roomId = `${creator.handle.replace('@','')}-${Date.now()}`;
        const booking = await Booking.create({
            fanName, fanEmail,
            creatorName: creator.name,
            creatorEmail: creator.email,
            sessionType,
            requestedDate: `${requestedDate} ${requestedTime}`,
            paymentIntentId: paymentIntentId || null,
            roomId,
            status: 'pending',
        });
        res.status(201).json({ success: true, bookingId: booking._id, roomId });
    } catch (err) {
        console.error('Booking creation failed:', err);
        res.status(500).json({ error: 'Could not create booking.' });
    }
});

// GET /creator/bookings — creator sees all pending/upcoming bookings
app.get('/creator/bookings', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        if (!user || user.role !== 'creator') return res.status(403).json({ error: 'Creator only.' });
        const bookings = await Booking.find({ creatorEmail: user.email, status: { $in: ['pending', 'accepted', 'confirmed', 'proposed'] } }).sort({ createdAt: -1 });
        res.json({ bookings });
    } catch (err) {
        console.error('Failed to fetch bookings:', err);
        res.status(500).json({ error: 'Could not fetch bookings.' });
    }
});

// PUT /booking/:id/respond — creator accepts, declines, or proposes new time
app.put('/booking/:id/respond', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        if (!user || user.role !== 'creator') return res.status(403).json({ error: 'Creator only.' });
        const booking = await Booking.findById(req.params.id);
        if (!booking) return res.status(404).json({ error: 'Booking not found.' });
        if (booking.creatorEmail !== user.email) return res.status(403).json({ error: 'Not your booking.' });
        const { action, proposedDate, proposedTime } = req.body;
        if (action === 'accept') {
            booking.status = 'confirmed';
            if (!booking.roomId) booking.roomId = `${user.handle.replace('@','')}-${Date.now()}`;
        } else if (action === 'decline') {
            booking.status = 'declined';
        } else if (action === 'propose') {
            booking.status = 'proposed';
            booking.proposedDate = proposedDate;
            booking.proposedTime = proposedTime;
        } else {
            return res.status(400).json({ error: 'Invalid action.' });
        }
        await booking.save();
        res.json({ success: true, booking });
    } catch (err) {
        console.error('Booking response failed:', err);
        res.status(500).json({ error: 'Could not update booking.' });
    }
});

// Return all creators who have a handle set (for the homepage browse grid)
app.get('/all-creators', async (req, res) => {
    try {
        const creators = await User.find(
            { role: 'creator', handle: { $ne: null, $ne: '' } },
            { name: 1, handle: 1, bio: 1, photo: 1, isLive: 1, inSession: 1, _id: 0 }
        ).sort({ isLive: -1, createdAt: -1 });
        res.json({ creators });
    } catch (err) {
        console.error('All creators error:', err);
        res.status(500).json({ error: 'Could not fetch creators.' });
    }
});

app.get('/creator/:handle', async (req, res) => {
    try {
        // Handle format is name@truthordare — normalise by stripping leading @ if present
        const handle = req.params.handle.replace(/^@/, '');
        const creator = await User.findOne({ handle, role: 'creator' }).select('name bio photo extraPhotos isLive inSession handle stripeAccountId socials');
        if (!creator) return res.status(404).json({ error: 'Creator not found.' });
        res.json({ creator });
    } catch (err) {
        console.error('Failed to fetch creator profile:', err);
        res.status(500).json({ error: 'Could not fetch.' });
    }
});

// ── END BOOKING ENDPOINTS ──────────────────────────────────────────────────────

// POST /notify-creator — fan sends a notification to a creator
app.post('/notify-creator', async (req, res) => {
    const { creatorHandle, fanName, fanEmail } = req.body;
    if (!creatorHandle || !fanName || !fanEmail) return res.status(400).json({ error: 'Missing fields.' });
    try {
        const handle = creatorHandle.replace(/^@/, '');
        const creator = await User.findOne({ handle, role: 'creator' });
        if (!creator) return res.status(404).json({ error: 'Creator not found.' });
        console.log(`🔔 Fan notification: ${fanName} (${fanEmail}) is interested in booking ${creator.name}`);
        const prefs = creator.notificationPrefs || {};
        const wantsEmail = prefs.email !== false; // default true
        const wantsSms = !!prefs.sms;
        const customHandle = prefs.customHandle || null;
        const frontendUrl = process.env.FRONTEND_URL || 'https://www.truthordareformyfans.com';

        // Build notification methods summary for the email
        const notifyMethods = [];
        if (wantsEmail) notifyMethods.push('Email');
        if (wantsSms && prefs.phone) notifyMethods.push(`SMS (${prefs.phone})`);
        if (customHandle) notifyMethods.push(customHandle);

        // 1. Send email notification if creator wants email
        if (wantsEmail) {
            const notifyHtml = `
                <div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#0d0000;color:#C9B99A;padding:32px;border-radius:12px;border:1px solid rgba(212,165,116,0.3);">
                    <h2 style="color:#D4A574;font-size:22px;margin-bottom:8px;">🔔 A fan is interested in booking you!</h2>
                    <p style="font-size:15px;margin-bottom:16px;"><strong style="color:#FDF6EC;">${fanName}</strong> wants to book a session with you but isn't ready to pay yet.</p>
                    <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
                        <tr><td style="padding:8px 0;color:#9A8A72;font-size:13px;">Fan name</td><td style="padding:8px 0;color:#FDF6EC;font-weight:700;">${fanName}</td></tr>
                        <tr><td style="padding:8px 0;color:#9A8A72;font-size:13px;">Fan email</td><td style="padding:8px 0;color:#FDF6EC;">${fanEmail}</td></tr>
                    </table>
                    ${customHandle ? `<p style="font-size:14px;color:#FDF6EC;margin-bottom:12px;">You also asked to be contacted via: <strong>${customHandle}</strong></p>` : ''}
                    <p style="font-size:13px;color:#9A8A72;">Reply directly to this email to reach out, or share your profile: <a href="${frontendUrl}/creator/${creator.handle}" style="color:#D4A574;">${frontendUrl}/creator/${creator.handle}</a></p>
                </div>`;
            await sendEmail(creator.email, `🔔 ${fanName} is interested in booking a session with you`, notifyHtml);
        }

        // 2. Return the creator's custom handle to the fan (so they know how to reach the creator)
        res.json({ success: true, notifyMethods, customHandle });
    } catch (err) {
        console.error('Notify creator failed:', err);
        res.status(500).json({ error: 'Could not send notification.' });
    }
});

// ── DELETE ACCOUNT ──────────────────────────────────────────────────────────
// Requires auth. Creator or fan can delete their own account.
// Creators: also removes their Featured entry and marks Stripe account as deleted.
app.delete('/account', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        if (!user) return res.status(404).json({ error: 'Account not found.' });

        // If creator, remove from Featured collection too
        if (user.role === 'creator') {
            await Featured.deleteMany({ email: user.email });
            // Optionally deauthorize Stripe Express account
            if (user.stripeAccountId) {
                try {
                    await stripe.accounts.del(user.stripeAccountId);
                } catch (stripeErr) {
                    console.warn('Stripe account deletion skipped:', stripeErr.message);
                }
            }
        }

        await User.findByIdAndDelete(req.user.userId);
        res.json({ success: true, message: 'Account deleted successfully.' });
    } catch (err) {
        console.error('Delete account error:', err);
        res.status(500).json({ error: 'Could not delete account.' });
    }
});

// POST /forgot-password — send reset link to email
app.post('/forgot-password', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required.' });
    try {
        const user = await User.findOne({ email: email.toLowerCase() });
        // Always return success to avoid email enumeration
        if (!user) return res.json({ message: 'If that email exists, a reset link has been sent.' });
        const token = crypto.randomBytes(32).toString('hex');
        user.resetToken = token;
        user.resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
        await user.save();
        const resetUrl = `${FRONTEND}/reset-password?token=${token}`;
        await sendEmail(user.email, 'Reset your Truth or Dare password', `
            <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;background:#1a0000;color:#FDF6EC;border-radius:10px;">
                <h2 style="color:#D4A574;font-size:24px;margin-bottom:8px;">Reset Your Password</h2>
                <p style="color:#C9B99A;margin-bottom:24px;">Click the button below to reset your password. This link expires in 1 hour.</p>
                <a href="${resetUrl}" style="display:inline-block;padding:14px 28px;background:#CC0000;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;font-size:16px;">Reset Password</a>
                <p style="color:#9A8A72;font-size:12px;margin-top:24px;">If you didn't request this, you can safely ignore this email.</p>
            </div>
        `);
        res.json({ message: 'If that email exists, a reset link has been sent.' });
    } catch (err) { res.status(500).json({ error: 'Could not process request.' }); }
});

// POST /reset-password — set new password using token
app.post('/reset-password', async (req, res) => {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and password required.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    try {
        const user = await User.findOne({ resetToken: token, resetTokenExpiry: { $gt: new Date() } });
        if (!user) return res.status(400).json({ error: 'Invalid or expired reset link. Please request a new one.' });
        user.passwordHash = await bcrypt.hash(password, 10);
        user.resetToken = null;
        user.resetTokenExpiry = null;
        await user.save();
        res.json({ message: 'Password reset successfully. You can now log in.' });
    } catch (err) { res.status(500).json({ error: 'Could not reset password.' }); }
});

// Admin: fix all handles to name@truthordare format
app.post('/admin/fix-handles', async (req, res) => {
    const { secret } = req.body;
    if (secret !== 'tod_admin_fix_2026') return res.status(403).json({ error: 'Forbidden' });
    try {
        const creators = await User.find({ role: 'creator', handle: { $ne: null } });
        let fixed = [];
        for (const c of creators) {
            let h = c.handle.replace(/^@+/, '').replace(/@truthordare$/i, '').trim().toLowerCase().replace(/\s+/g, '');
            const newHandle = h ? `${h}@truthordare` : null;
            if (newHandle !== c.handle) {
                fixed.push({ old: c.handle, new: newHandle, name: c.name });
                c.handle = newHandle;
                await c.save();
            }
        }
        res.json({ success: true, fixed });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: update any creator profile by handle
app.post('/admin/update-creator', async (req, res) => {
    const { secret, handle, updates } = req.body;
    if (secret !== 'tod_admin_fix_2026') return res.status(403).json({ error: 'Forbidden' });
    try {
        const creator = await User.findOneAndUpdate(
            { handle },
            { $set: updates },
            { new: true }
        );
        if (!creator) return res.status(404).json({ error: 'Creator not found' });
        res.json({ success: true, creator: { name: creator.name, handle: creator.handle, bio: creator.bio } });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: delete a creator by name
app.post('/admin/delete-creator', async (req, res) => {
    const { secret, name } = req.body;
    if (secret !== 'tod_admin_fix_2026') return res.status(403).json({ error: 'Forbidden' });
    try {
        const result = await User.findOneAndDelete({ name, role: 'creator' });
        if (!result) return res.status(404).json({ error: 'Creator not found' });
        res.json({ success: true, deleted: result.name });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/', (req, res) => res.send('truthordareformyfans.com backend ✓'));

app.listen(PORT, () => {
    console.log(`\n🎯 Server running at http://localhost:${PORT}`);
    console.log(`   Stripe: ${process.env.STRIPE_SECRET_KEY?.startsWith('sk_live') ? 'LIVE 🔴' : 'TEST ✅'}`);
    console.log(`   Split: 85% creator / 15% platform\n`);
});
